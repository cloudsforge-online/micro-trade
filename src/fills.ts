/**
 * Fills. **A fill is money.**
 *
 * The whole file is one argument, and it is the same one the frozen service makes at
 * `crucible/services/crucible/src/runner.ts:263-276`: the row is written FIRST, before anything
 * moves, because the gap between deciding to fill and having filled is exactly where a crash costs
 * somebody money.
 *
 * ## Exactly-once, in three layers
 *
 * Each layer alone is not enough, and each one fails in the same direction — toward doing nothing
 * rather than toward doing it twice.
 *
 *   1. **`fills_bot_bar_side_uniq`.** A duplicate evaluation of the same bar loses the insert and
 *      stops here rather than at the ledger. This is the frozen service's index
 *      (`crucible/services/crucible/src/db/migrate.ts:159`), carried forward because it is right.
 *   2. **A derived idempotency key.** `trade:fill:<row id>` — so even a retry of the SAME row, after
 *      an answer was lost, replays the ledger's stored response instead of posting again.
 *   3. **A conditional `UPDATE … WHERE status IN ('planned','unresolved')`.** This is the one the
 *      other two do not cover. The row exists and the entry posted; what must happen exactly once is
 *      the *application* of that fill to the bot's cash and position. Two workers that both
 *      discovered the same settled entry would otherwise both add the coin. The update and the bot
 *      mutation are in one transaction, and the update is what claims the right to do it.
 *
 * ## An unknown outcome is not a refusal
 *
 * The status a fill lands in when the ledger does not answer is `unresolved`, not `refused`, and the
 * distinction is the difference between a working service and one that trades twice. A 4xx means the
 * ledger looked and said no: nothing moved, the row is zeroed, and the bar is done. A timeout or a
 * 5xx means **we do not know**, and writing "nothing moved" would be as much of a claim as leaving
 * the plan there. The frozen runner reaches the same conclusion at
 * `crucible/services/crucible/src/runner.ts:355-358`.
 */

import { amountFrom } from './money.ts'
import {
  LedgerInFlightError,
  LedgerRefusedError,
  LedgerUnavailableError,
  fillIdempotencyKey,
  fillPostings,
  type LedgerClient,
} from './ledgerclient.ts'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import type { Db, Emit, Tx } from './outbox.ts'

export type FillSide = 'buy' | 'sell'
export type FillMode = 'paper' | 'live'
export type FillStatus = 'planned' | 'settled' | 'refused' | 'unresolved'

export interface FillRecord {
  readonly id: string
  readonly botId: string
  readonly userId: string
  readonly barT: number
  readonly side: FillSide
  readonly mode: FillMode
  readonly priceScaled: bigint
  readonly qty: bigint
  /** Shards moved, signed: negative on a buy, positive on a sell. */
  readonly shards: bigint
  readonly feeShards: bigint
  readonly reason: string
  readonly status: FillStatus
  readonly entryId: string | null
  readonly error: string | null
}

interface FillRow {
  readonly id: string
  readonly bot_id: string
  readonly user_id: string
  readonly bar_t: string | number
  readonly side: string
  readonly mode: string
  readonly price_scaled: string
  readonly qty: string
  readonly shards: string
  readonly fee_shards: string
  readonly reason: string
  readonly status: string
  readonly entry_id: string | null
  readonly error: string | null
}

export const toFill = (row: FillRow): FillRecord => ({
  id: row.id,
  botId: row.bot_id,
  userId: row.user_id,
  barT: Number(row.bar_t),
  side: row.side as FillSide,
  mode: row.mode as FillMode,
  priceScaled: amountFrom(row.price_scaled),
  qty: amountFrom(row.qty),
  shards: amountFrom(row.shards),
  feeShards: amountFrom(row.fee_shards),
  reason: row.reason,
  status: row.status as FillStatus,
  entryId: row.entry_id,
  error: row.error,
})

const COLUMNS = `id, bot_id, user_id, bar_t, side, mode, price_scaled, qty, shards, fee_shards, reason, status, entry_id, error`

export interface PlannedFill {
  readonly botId: string
  readonly userId: string
  readonly barT: number
  readonly side: FillSide
  readonly mode: FillMode
  readonly priceScaled: bigint
  readonly qty: bigint
  readonly shards: bigint
  readonly feeShards: bigint
  readonly reason: string
}

/**
 * Book the intent to fill.
 *
 * Returns `null` when this bot has already filled that side on that bar — a **replay, not a
 * failure**, and the caller treats it as "already done". Returning null rather than throwing is
 * deliberate: a tick that loses this race has done nothing wrong, and turning a benign replay into
 * an error would put a red line in a log every time two workers overlapped.
 */
export async function bookFill(sql: Db | Tx, planned: PlannedFill): Promise<FillRecord | null> {
  const rows = await sql<FillRow[]>`
    insert into fills (bot_id, user_id, bar_t, side, mode, price_scaled, qty, shards, fee_shards, reason, status)
    values (
      ${planned.botId}, ${planned.userId}, ${planned.barT}, ${planned.side}, ${planned.mode},
      ${planned.priceScaled.toString()}, ${planned.qty.toString()},
      ${planned.shards.toString()}, ${planned.feeShards.toString()},
      ${planned.reason}, 'planned'
    )
    on conflict (bot_id, bar_t, side) do nothing
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toFill(row) : null
}

export async function getFill(sql: Db, id: string): Promise<FillRecord | null> {
  const rows = await sql<FillRow[]>`select ${sql.unsafe(COLUMNS)} from fills where id = ${id}`
  const row = rows[0]
  return row ? toFill(row) : null
}

export async function listFills(sql: Db, botId: string, limit: number): Promise<readonly FillRecord[]> {
  const rows = await sql<FillRow[]>`
    select ${sql.unsafe(COLUMNS)} from fills
     where bot_id = ${botId} order by created_at desc limit ${limit}
  `
  return rows.map(toFill)
}

/** What actually happened, once the outcome is known. */
export interface FillOutcome {
  readonly priceScaled: bigint
  readonly qty: bigint
  /** Signed: negative on a buy, positive on a sell. */
  readonly shards: bigint
  readonly feeShards: bigint
  readonly entryId: string | null
}

export type ApplyResult =
  /** This call claimed the fill and moved the bot. */
  | { readonly status: 'applied'; readonly fill: FillRecord }
  /** Somebody else claimed it first. Nothing was moved by this call, and nothing should be. */
  | { readonly status: 'already' }

/**
 * Apply a settled fill to its bot, exactly once.
 *
 * The conditional update is the claim. `where status in ('planned','unresolved')` means the second
 * caller updates zero rows, reads zero rows back, and returns `already` — so the bot mutation below
 * it runs for exactly one of them however many are racing.
 *
 * The bot's `position` and `cash` are moved by the amounts on the fill row rather than by anything
 * the caller passes separately, so the row and the movement cannot disagree. This is the direct fix
 * for the divergence 04 §11 names: the frozen runner writes `cash` and `position` computed in memory
 * and then advances `last_candle_t` in the same statement
 * (`crucible/services/crucible/src/runner.ts:186-196`), so a crash after the ledger moved and before
 * that write leaves money moved and a mirror that says it did not — permanently, because the bar
 * pointer has advanced past it.
 */
export async function applyFill(
  sql: Db,
  fillId: string,
  outcome: FillOutcome,
  emit?: Emit,
): Promise<ApplyResult> {
  const result = await sql.begin(async (tx) => {
    const rows = await tx<FillRow[]>`
      update fills
         set status       = 'settled',
             price_scaled = ${outcome.priceScaled.toString()},
             qty          = ${outcome.qty.toString()},
             shards       = ${outcome.shards.toString()},
             fee_shards   = ${outcome.feeShards.toString()},
             entry_id     = ${outcome.entryId},
             error        = null,
             settled_at   = now()
       where id = ${fillId}
         and status in ('planned','unresolved')
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) return { value: { status: 'already' } as ApplyResult }
    const fill = toFill(row)

    // The signed `shards` and the side together are the whole movement. A buy spends Shards and
    // gains units; a sell is the mirror. Written as one statement so no intermediate state exists in
    // which the position moved and the cash did not.
    const unitsDelta = fill.side === 'buy' ? fill.qty : -fill.qty
    await tx`
      update bots
         set cash     = cash + ${fill.shards.toString()}::numeric,
             position = position + ${unitsDelta.toString()}::numeric
       where id = ${fill.botId}
    `
    return { value: { status: 'applied', fill } as ApplyResult }
  })
  const value = result.value
  if (value.status === 'applied' && emit) {
    emit({
      topic: 'trade.fill.settled',
      key: value.fill.id,
      payload: {
        fillId: value.fill.id,
        botId: value.fill.botId,
        side: value.fill.side,
        qty: value.fill.qty.toString(),
        shards: value.fill.shards.toString(),
        entryId: value.fill.entryId,
      },
    })
  }
  return value
}

/** Record that the ledger refused. Nothing moved and nothing will; the bar is done. */
export async function refuseFill(sql: Db, fillId: string, reason: string): Promise<void> {
  await sql`
    update fills
       set status = 'refused', qty = 0, shards = 0, fee_shards = 0, error = ${reason.slice(0, 2_000)}
     where id = ${fillId} and status in ('planned','unresolved')
  `
}

/**
 * Record that the outcome is unknown.
 *
 * The planned amounts are LEFT IN PLACE. Zeroing them would state that nothing moved, which is
 * precisely what is not known. The row stays claimable by a later pass under the same key.
 */
export async function markFillUnresolved(sql: Db, fillId: string, reason: string): Promise<void> {
  await sql`
    update fills
       set status = 'unresolved', error = ${reason.slice(0, 2_000)}
     where id = ${fillId} and status in ('planned','unresolved')
  `
}

export interface SettleFillDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly asset: AssetCode
  readonly correlationId: string
}

/**
 * Post a booked fill to the ledger and apply it, or record why not.
 *
 * Safe to call any number of times for one fill row: the ledger key is derived from the row id, so a
 * repeat replays; and `applyFill` claims the row, so a repeat that finds it already applied moves
 * nothing. That is the property the concurrency test drives.
 */
export async function settleFill(deps: SettleFillDeps, fill: FillRecord, emit?: Emit): Promise<ApplyResult | { status: 'refused' | 'unresolved'; reason: string }> {
  const notional = fill.shards < 0n ? -fill.shards : fill.shards
  try {
    const entry = await deps.ledger.postEntry({
      kind: 'trading_fill',
      actor: `service:trade`,
      correlationId: deps.correlationId,
      idempotencyKey: fillIdempotencyKey(fill.id),
      description: `Fill ${fill.side} ${fill.qty} ${deps.asset}`,
      postings: fillPostings({
        userId: fill.userId,
        asset: deps.asset,
        side: fill.side,
        notionalShards: notional,
        units: fill.qty,
        feeShards: fill.feeShards,
      }),
    })
    return await applyFill(
      deps.sql,
      fill.id,
      {
        priceScaled: fill.priceScaled,
        qty: fill.qty,
        shards: fill.shards,
        feeShards: fill.feeShards,
        entryId: entry.id,
      },
      emit,
    )
  } catch (err) {
    if (err instanceof LedgerRefusedError) {
      await refuseFill(deps.sql, fill.id, `${err.code}: ${err.message}`)
      return { status: 'refused', reason: err.message }
    }
    if (err instanceof LedgerInFlightError || err instanceof LedgerUnavailableError) {
      await markFillUnresolved(deps.sql, fill.id, err.message)
      return { status: 'unresolved', reason: err.message }
    }
    throw err
  }
}
