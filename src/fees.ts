/**
 * The performance fee.
 *
 * **Ported from `crucible/services/crucible/src/fees.ts`**, which is the single best-reasoned file
 * in the frozen estate — four invariants, each written down because breaking it overcharged
 * somebody. They are carried forward in full. What is added is the one thing that file could not
 * fix from inside itself: a **schema-level identity for a settlement**.
 *
 * Trade is free until it makes money. Backtests, the strategy catalogue and paper trading never cost
 * anything. The only charge is a share of a LIVE bot's gains, assessed against a HIGH-WATER MARK —
 * the highest equity the bot has ever been billed at. See `performanceFee` in `src/money.ts` for why
 * that one rule is what makes the fee defensible.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * INVARIANT 0 — ONE SETTLEMENT PER (BOT, PERIOD), ENFORCED BY THE DATABASE. **New.**
 *
 * The frozen row's identity is `randomUUID()` (`crucible/services/crucible/src/store.ts`) and its
 * upstream idempotency key is derived from that id (`crucible/services/crucible/src/clients/pay.ts`).
 * Two attempts at the same settlement therefore produce two DIFFERENT keys, and the upstream
 * correctly honours both — `fee_settlements` has no unique constraint to catch it. That race is
 * live at one replica, between the hourly sweep and the stop route.
 *
 * Here the identity is `(bot_id, period)` where `period = floor(now / TRADE_SETTLEMENT_PERIOD_SECONDS)`,
 * the unique constraint refuses the second insert, and the ledger key is derived from the period
 * rather than the row. Three things would each have to fail for a double bill, instead of none.
 * 14 §5 names this as a mandatory concurrency test; `fees.test.ts` is that test.
 *
 * INVARIANT 1 — THE MARK NEVER MOVES DOWN. It used to be assigned `bot.equity` unconditionally at
 * the end of a settlement. A pass that carried arrears while equity had FALLEN below the mark still
 * reached that assignment — the fee was zero but the arrears made the total billable — and dragged
 * the mark down to the lower equity. The climb back was then billed all over again.
 *
 * INVARIANT 2 — ONE SETTLEMENT ROW IS CHARGED UNDER EXACTLY ONE KEY, for one amount, recorded on the
 * row before it is sent. A short wallet used to be handled by charging a smaller amount under a
 * SECOND key; a crash between that charge and the row update left a pending row that the next pass
 * re-sent in FULL under the first key. Both landed.
 *
 * INVARIANT 3 — THE DEBT IS RECORDED BEFORE THE ROW EXISTS. `feeOwed` and the advanced mark are
 * written first, so every crash window after that point can only UNDER-collect. Crashing earlier
 * just re-assesses the same gain next pass.
 *
 * INVARIANT 4 — AN UNKNOWN OUTCOME IS NOT A REFUSAL, AND NOTHING NEW IS ASSESSED WHILE ONE IS
 * OUTSTANDING. Invariant 2 makes one ROW safe to retry; it says nothing about two rows. A charge
 * whose answer was lost — a timeout that fired while the ledger's transaction committed, a pod
 * rotated mid-response, a reset connection — used to be written off `uncollectable`, which restored
 * the whole debt to `feeOwed` and took the row out of the pending set for good. The next pass then
 * re-billed the identical arrears under a BRAND NEW key. One lost answer, two debits. So: only the
 * ledger saying no may retire a row, and while any row's outcome is unknown this pass assesses
 * nothing at all. Deferring costs nothing — the gain stays under the mark, un-advanced, and is
 * billed in full on the first pass that finds the pending set clean.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## This is the retry loop, and it is a real one
 *
 * `micro-org`'s inherited `MICROSERVICES.md` states "There are also **zero retries anywhere**"
 * about the frozen estate. That claim is **false**, and the code it is false about is this file's
 * ancestor: `resolvePending` re-sends every undecided row under its original key on every pass, and
 * `settlementSweep` (`crucible/services/crucible/src/runner.ts`) drives it over both the
 * running bots and the ones that have left the running set still owing something. The retry horizon
 * is unbounded by design, the `attempted` column exists specifically so a retry re-sends an
 * identical request (`crucible/services/crucible/src/db/migrate.ts`), and the stop route
 * says so in a comment ("the settlement sweep will retry it",
 * `crucible/services/crucible/src/routes/bots.ts`). What the frozen estate lacks is
 * *in-request* retry inside its HTTP client — a different and much smaller claim.
 */

import { Logger } from '@cloudsforge/telemetry'
import { amountFrom, performanceFee } from './money.ts'
import {
  LedgerInFlightError,
  LedgerRefusedError,
  LedgerUnavailableError,
  performanceFeePostings,
  settlementIdempotencyKey,
  type LedgerClient,
} from './ledgerclient.ts'
import { updateBot, type BotRecord, type Mark } from './bots.ts'
import type { Clock } from './rng.ts'
import type { Db, Emit } from './outbox.ts'

/**
 * How much of a settlement a pass is allowed to do.
 *
 * `assess` — the whole thing. Resolve the pending rows, work out the fee on the gain above the mark,
 * add whatever is already owed, charge the total and advance the mark past the gain that was billed.
 * This is what a RUNNING bot gets, and what a bot gets on the way out of `stop`, where the position
 * has just been liquidated and `equity` is a realised number.
 *
 * `arrears` — reconciliation only. Resolve the pending rows, then collect what the bot ALREADY owes,
 * assessing no new fee and never touching the mark.
 *
 * The distinction exists because the sweep reaches bots that are not running, and `paused` is in
 * that set. A paused bot is not flat: the position stays open by design — pause is explicitly not a
 * flatten — so its `equity` is a mark-to-market number from whenever it last ticked, against an
 * unrealised position that may be worth anything by now. Assessing it would bill a gain the user has
 * not made and cannot take. Worse, it would be arbitrary: the only thing putting a paused bot in the
 * sweep's second list is a cent of arrears, so of two identical paused bots the one that happens to
 * owe 1 cent would be billed for its whole unrealised gain and the other for nothing.
 */
export type SettleScope = 'assess' | 'arrears'

export type SettlementStatus = 'pending' | 'charged' | 'partial' | 'uncollectable'

export interface SettlementRecord {
  readonly id: string
  readonly botId: string
  readonly userId: string
  readonly period: bigint
  readonly equity: bigint
  readonly highWaterMark: bigint
  readonly gain: bigint
  readonly fee: bigint
  readonly attempted: bigint
  readonly collected: bigint
  readonly status: SettlementStatus
  readonly entryId: string | null
}

interface SettlementRow {
  readonly id: string
  readonly bot_id: string
  readonly user_id: string
  readonly period: string | number
  readonly equity: string
  readonly high_water_mark: string
  readonly gain: string
  readonly fee: string
  readonly attempted: string
  readonly collected: string
  readonly status: string
  readonly entry_id: string | null
}

const COLUMNS = `id, bot_id, user_id, period, equity, high_water_mark, gain, fee, attempted, collected, status, entry_id`

const toSettlement = (row: SettlementRow): SettlementRecord => ({
  id: row.id,
  botId: row.bot_id,
  userId: row.user_id,
  period: BigInt(row.period),
  equity: amountFrom(row.equity),
  highWaterMark: amountFrom(row.high_water_mark),
  gain: amountFrom(row.gain),
  fee: amountFrom(row.fee),
  attempted: amountFrom(row.attempted),
  collected: amountFrom(row.collected),
  status: row.status as SettlementStatus,
  entryId: row.entry_id,
})

/**
 * The accrual period a settlement belongs to.
 *
 * Floor division of the clock by the configured width, so every replica evaluating the same instant
 * agrees on the answer without asking each other. This is what makes `(bot_id, period)` a
 * well-defined key rather than a hopeful one.
 */
export function periodFor(clock: Clock, periodSeconds: number): bigint {
  return BigInt(Math.floor(clock.now() / 1000 / periodSeconds))
}

/** How a settlement attempt ended, for the caller's log line. */
export interface SettleOutcome {
  readonly settlement: SettlementRecord | null
  /**
   * Set when the pass ended without a decided charge: the ledger is unreachable, an earlier row's
   * outcome is not known yet and invariant 4 holds the next assessment back until it is, or the only
   * thing left to bill is arrears the wallet cannot cover a single cent of.
   *
   * Every one of these means "ask again", which is what the sweep is for.
   */
  readonly deferred?: string
}

/** What the ledger's answer proves about where the money is. */
export type ChargeVerdict =
  /** The debit committed and the ledger said so. */
  | 'collected'
  /** Refused on the balance. Nothing moved, and a smaller charge may fit. */
  | 'insufficient'
  /** Refused, deliberately and finally. Nothing moved and nothing will. */
  | 'refused'
  /** The ledger may or may not hold the money. Only it can say, and it has not. */
  | 'unresolved'

interface ChargeResult {
  readonly verdict: ChargeVerdict
  readonly entryId: string | null
  readonly error?: string
}

/**
 * Send one charge and classify the answer, because `!ok` is two completely different facts.
 *
 * A 4xx is the ledger saying no, and EVERYTHING ELSE is a lost answer rather than a lost charge. The
 * one that matters most is a timeout, because that is exactly the shape of a charge that committed
 * and whose response never came back. Treating it as "not charged" is how the same arrears get
 * billed twice under two different keys.
 */
async function charge(
  ledger: LedgerClient,
  row: SettlementRecord,
  correlationId: string,
): Promise<ChargeResult> {
  try {
    const entry = await ledger.postEntry({
      kind: 'performance_fee',
      actor: 'service:trade',
      correlationId,
      // Same key, always: derived from (bot, period), never from the row. If it went through, the
      // ledger replays its stored response and this is a no-op; if it did not, it happens now.
      idempotencyKey: settlementIdempotencyKey(row.botId, row.period),
      description: `Trade performance fee, period ${row.period}`,
      postings: performanceFeePostings({ userId: row.userId, amountUsdCents: row.attempted }),
    })
    return { verdict: 'collected', entryId: entry.id }
  } catch (err) {
    if (err instanceof LedgerRefusedError) {
      return {
        verdict: err.code === 'insufficient_funds' ? 'insufficient' : 'refused',
        entryId: null,
        error: err.message,
      }
    }
    // In flight, or unreachable, or a 5xx. Either way the outcome is unknown.
    if (err instanceof LedgerInFlightError || err instanceof LedgerUnavailableError) {
      return { verdict: 'unresolved', entryId: null, error: err.message }
    }
    throw err
  }
}

export interface FeeDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly clock: Clock
  readonly logger: Logger
  readonly periodSeconds: number
  readonly correlationId: string
}

async function updateSettlement(
  sql: Db,
  id: string,
  patch: { attempted?: bigint; collected?: bigint; status?: SettlementStatus; entryId?: string | null; lastError?: string | null; resolved?: boolean },
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (patch.attempted !== undefined) set['attempted'] = patch.attempted.toString()
  if (patch.collected !== undefined) set['collected'] = patch.collected.toString()
  if (patch.status !== undefined) set['status'] = patch.status
  if (patch.entryId !== undefined) set['entry_id'] = patch.entryId
  if (patch.lastError !== undefined) set['last_error'] = patch.lastError
  if (patch.resolved) set['resolved_at'] = new Date()
  if (Object.keys(set).length === 0) return
  await sql`update fee_settlements set ${sql(set)} where id = ${id}`
}

async function pendingSettlements(sql: Db, botId: string): Promise<readonly SettlementRecord[]> {
  const rows = await sql<SettlementRow[]>`
    select ${sql.unsafe(COLUMNS)} from fee_settlements
     where bot_id = ${botId} and status = 'pending' order by period asc
  `
  return rows.map(toSettlement)
}

export async function listSettlements(sql: Db, botId: string, limit: number): Promise<readonly SettlementRecord[]> {
  const rows = await sql<SettlementRow[]>`
    select ${sql.unsafe(COLUMNS)} from fee_settlements
     where bot_id = ${botId} order by created_at desc limit ${limit}
  `
  return rows.map(toSettlement)
}

/**
 * Charge a row, lowering it to what the wallet can cover if it must.
 *
 * The ledger's debit is all-or-nothing by design — its balance guard is what makes it race-safe — so
 * collecting a partial amount means asking what the balance is and charging that instead. Two things
 * make that safe to retry, and both are properties of `micro-ledger/src/idempotency.ts` rather than
 * assumptions about it:
 *
 *   - The ledger claims the key **inside the same transaction as the posting**, so a refusal on the
 *     balance rolls the claim back too. The key is free again, which is why the smaller charge can
 *     reuse it rather than needing one of its own — and needing one of its own is exactly what
 *     invariant 2 forbids.
 *   - The smaller amount is written to the row BEFORE it is sent. Whatever happens next, the row
 *     states the one request that may have committed, and a retry re-sends that request byte for
 *     byte.
 */
async function collect(deps: FeeDeps, row: SettlementRecord): Promise<{ collected: bigint; attempted: bigint; entryId: string | null; unresolved: boolean; error?: string }> {
  const first = await charge(deps.ledger, row, deps.correlationId)
  if (first.verdict === 'collected') {
    return { collected: row.attempted, attempted: row.attempted, entryId: first.entryId, unresolved: false }
  }
  // A refusal that is not about the balance ends here with the outcome KNOWN; an unknown one ends
  // here with it unknown, and the caller must not confuse the two. Only `insufficient` is worth
  // asking a second, smaller question.
  if (first.verdict !== 'insufficient') {
    return {
      collected: 0n,
      attempted: row.attempted,
      entryId: null,
      unresolved: first.verdict === 'unresolved',
      ...(first.error !== undefined ? { error: first.error } : {}),
    }
  }

  const available = await deps.ledger.availableUsdCents(row.userId)
  if (available === null) {
    // The ledger would not say. That is not zero — it is "do not know" — so this row stays pending
    // and the next pass asks again. Reading it as zero would retire a row on the strength of an
    // outage.
    return { collected: 0n, attempted: row.attempted, entryId: null, unresolved: true, error: 'the ledger would not report the balance' }
  }
  const affordable = available < row.attempted ? available : row.attempted
  if (affordable < 1n) {
    // A decided outcome, not an unresolved one: the full charge was REFUSED on the balance, so
    // nothing committed under this key and re-assessing next pass cannot double-charge.
    return { collected: 0n, attempted: row.attempted, entryId: null, unresolved: false, error: 'the wallet cannot cover the fee' }
  }
  if (affordable < row.attempted) await updateSettlement(deps.sql, row.id, { attempted: affordable })

  const lowered: SettlementRecord = { ...row, attempted: affordable }
  const second = await charge(deps.ledger, lowered, deps.correlationId)
  if (second.verdict === 'collected') {
    return { collected: affordable, attempted: affordable, entryId: second.entryId, unresolved: false }
  }
  return {
    collected: 0n,
    attempted: affordable,
    entryId: null,
    unresolved: second.verdict === 'unresolved',
    error: second.error ?? 'partial collection failed',
  }
}

/**
 * Finish rows whose charge outcome was never recorded, returning the bot's fee totals afterwards and
 * how many rows are still undecided.
 *
 * Totals are RETURNED rather than written per row and re-read, because every update here used to be
 * computed from the same stale in-memory bot and then overwritten by the caller a moment later — so
 * a recovered arrear was collected from the user and then erased from their record of it.
 *
 * `unresolved` is what invariant 4 is enforced from. A non-zero count means the arrears on `feeOwed`
 * may already be sitting at the ledger under a key we hold.
 */
async function resolvePending(
  deps: FeeDeps,
  bot: BotRecord,
): Promise<{ feePaid: bigint; feeOwed: bigint; unresolved: number }> {
  let feePaid = bot.feePaid
  let feeOwed = bot.feeOwed
  let unresolved = 0

  for (const row of await pendingSettlements(deps.sql, bot.id)) {
    const result = await charge(deps.ledger, row, deps.correlationId)
    if (result.verdict === 'collected') {
      await updateSettlement(deps.sql, row.id, {
        collected: row.attempted,
        status: row.attempted >= row.fee ? 'charged' : 'partial',
        entryId: result.entryId,
        resolved: true,
      })
      feePaid += row.attempted
      // The row's whole `fee` was booked into feeOwed when it was written, so collecting it CLEARS
      // that much of the arrears. Adding to them here was double counting — the debt grew by the
      // same amount that paid it off.
      feeOwed = feeOwed > row.attempted ? feeOwed - row.attempted : 0n
      continue
    }
    if (result.verdict === 'insufficient' || result.verdict === 'refused') {
      // The ledger decided, and decided no: nothing committed under this key and nothing ever will.
      // Retiring the row is what keeps the pending set — and therefore the next assessment — from
      // being blocked for ever by a charge that can only be refused. The debt itself is untouched on
      // `feeOwed`, so it is re-assessed next period, which is safe precisely because this key moved
      // no money.
      await updateSettlement(deps.sql, row.id, {
        collected: 0n,
        status: 'uncollectable',
        lastError: result.error ?? null,
        resolved: true,
      })
      continue
    }
    unresolved += 1
    deps.logger.warn('fee settlement still unresolved', {
      botId: bot.id,
      settlementId: row.id,
      err: result.error,
    })
  }

  if (feePaid !== bot.feePaid || feeOwed !== bot.feeOwed) {
    await updateBot(deps.sql, bot.id, { feePaid, feeOwed })
  }
  return { feePaid, feeOwed, unresolved }
}

/**
 * Assess and collect the performance fee on a bot's current equity — or, under `scope: 'arrears'`,
 * collect only what it already owes and assess nothing.
 *
 * Returns `settlement: null` when there is nothing to bill, which is the common case, and
 * deliberately writes no row for it. A settlement history full of "billed you nothing" entries
 * buries the ones that matter.
 */
export async function settle(
  deps: FeeDeps,
  bot: BotRecord,
  scope: SettleScope = 'assess',
  emit?: Emit,
): Promise<SettleOutcome> {
  const { feePaid, feeOwed, unresolved } = await resolvePending(deps, bot)

  if (unresolved > 0) {
    // Invariant 4.
    deps.logger.warn('fee assessment deferred — an earlier settlement has not resolved', {
      botId: bot.id,
      userId: bot.userId,
      unresolved,
      feeOwed: feeOwed.toString(),
    })
    return { settlement: null, deferred: `${unresolved} unresolved fee settlement(s)` }
  }

  // An `arrears` pass never looks at the gain at all — not `max(0, …)`, which would already be zero
  // for a bot under its mark, but structurally, because the equity it would be measured against is
  // not a number anyone can act on for a bot that is not running. See `SettleScope`.
  const fee = scope === 'assess' ? performanceFee(bot.equity, bot.highWaterMark, bot.feeBps) : 0n
  const due = fee + feeOwed

  if (due < 1n) {
    // No fee, but the mark still must not advance: a gain too small to bill today should accumulate
    // until it is worth billing, not be forgiven.
    return { settlement: null }
  }

  if (fee < 1n) {
    // Nothing new to bill — every cent of `due` is arrears assessed on some earlier pass and
    // recorded on a row of its own. Ask what the wallet holds before writing another one.
    //
    // This is `collect`'s own rule moved one step earlier, and it exists because arrears do not
    // expire. A stopped bot's equity never changes again, so a bot carrying arrears no wallet can
    // cover would produce an IDENTICAL uncollectable row every period, for ever — each a permanent
    // line on the user's billing page burying the settlements that actually charged them.
    //
    // A balance the ledger will not report reads as null and defers too. That is the safe direction:
    // the debt stays on `feeOwed`, the mark has not moved, and the next pass assesses the same
    // amount.
    const available = await deps.ledger.availableUsdCents(bot.userId)
    if (available === null || available < 1n) {
      return { settlement: null, deferred: 'the wallet cannot cover any of the arrears' }
    }
  }

  const gain = scope === 'assess' && bot.equity > bot.highWaterMark ? bot.equity - bot.highWaterMark : 0n
  const period = periodFor(deps.clock, deps.periodSeconds)

  // Invariants 1 and 3, in one write. The mark takes the HIGHER of where it already was and where
  // equity is now — a bot billed for arrears while under water leaves its mark exactly where it was —
  // and the whole amount becomes the arrears, so nothing after this point can bill this gain again.
  //
  // An `arrears` pass sends no mark at all rather than sending the one it read. Same value,
  // different promise: it says this pass has no opinion on where the mark belongs, so a bot paused
  // above its mark keeps that gain intact and is billed for it by the first pass after it runs again.
  await updateBot(deps.sql, bot.id, {
    ...(scope === 'assess'
      ? { highWaterMark: bot.equity > bot.highWaterMark ? bot.equity : bot.highWaterMark }
      : {}),
    feeOwed: due,
  })

  // Invariant 0. `on conflict do nothing` rather than a pre-read: a second pass in the same period
  // loses the insert and returns no row, so it cannot derive a second key. This is the line the
  // two-worker test drives.
  const inserted = await deps.sql<SettlementRow[]>`
    insert into fee_settlements (bot_id, user_id, period, equity, high_water_mark, gain, fee, attempted, collected, status)
    values (
      ${bot.id}, ${bot.userId}, ${period.toString()},
      ${bot.equity.toString()}, ${bot.highWaterMark.toString()}, ${gain.toString()},
      ${due.toString()}, ${due.toString()}, 0, 'pending'
    )
    on conflict (bot_id, period) do nothing
    returning ${deps.sql.unsafe(COLUMNS)}
  `
  const fresh = inserted[0]
  if (!fresh) {
    // Another pass already owns this period. Not an error and not a retry: the row it wrote is the
    // one that will be charged, under the one key that period has, and this pass is finished.
    deps.logger.info('settlement for this period already exists — leaving it to its owner', {
      botId: bot.id,
      period: period.toString(),
    })
    return { settlement: null, deferred: `period ${period} is already settled by another pass` }
  }

  const row = toSettlement(fresh)
  const { collected, attempted, entryId, unresolved: undecided, error } = await collect(deps, row)

  if (undecided) {
    // The charge may be committing right now, or may have committed already and lost its answer.
    // Writing it off as uncollectable would record a debt for money that has left — or is about to
    // leave — the wallet, and then bill it a second time under a second key. Leave the row pending;
    // the next pass re-sends the same key and is told which way it went, and invariant 4 keeps
    // anything new off the wallet until it is.
    await updateSettlement(deps.sql, row.id, { lastError: error ?? 'outcome unknown' })
    deps.logger.warn('fee settlement outcome is unknown — left pending for the next pass', {
      botId: bot.id,
      settlementId: row.id,
      err: error,
    })
    return { settlement: { ...row, attempted }, deferred: error ?? 'settlement outcome unknown' }
  }

  const status: SettlementStatus =
    collected >= due ? 'charged' : collected > 0n ? 'partial' : 'uncollectable'

  await updateSettlement(deps.sql, row.id, {
    collected,
    status,
    entryId,
    lastError: error ?? null,
    resolved: true,
  })
  await updateBot(deps.sql, bot.id, { feePaid: feePaid + collected, feeOwed: due - collected })

  if (collected > 0n) {
    // ── WHAT `status` AND `due` ARE DOING HERE — micro-org#367 ───────────────────────────────────
    //
    // The payload used to be `{ settlementId, botId, period, collected, entryId }`, and a PARTIAL
    // collection was byte-identical to a full one: `collected` alone says how much arrived and
    // nothing says how much was owed, so no consumer could tell "we took the fee" from "we took
    // what your balance could cover and you still owe the rest". Both `activity` and `notify`
    // wrote that limit down against their own rules on 2026-08-10 rather than hedging their copy,
    // and both are waiting on this field: the mail this topic sends says the fee was charged, in
    // all three cases.
    //
    // `due` and not `outstanding`, because `due - collected` is derivable and the reverse is not:
    // a consumer that wants the shortfall can subtract, and one that wants to know whether the
    // whole assessment landed needs the assessment. Both are cent counts in smallest units, which
    // is why the SENTENCE a consumer builds has to come off `status` — `trade` is a
    // smallest-units producer, so `money()` in activity declines to render either figure and a
    // template that tried would print a number eighteen orders of magnitude out.
    //
    // The `collected > 0n` guard STAYS, and `uncollectable` is therefore a status this emit can
    // never carry. That is not the same defect wearing a different hat: an uncollectable
    // settlement moved no money, `notify`'s live rule renders this topic as "a performance fee was
    // charged", and publishing a charge that did not happen is worse than publishing nothing. The
    // fact that a bot is in arrears is a different fact and wants a topic of its own — filed on
    // micro-org#367 rather than smuggled in under this name.
    emit?.({
      topic: 'trade.fee.settled',
      key: row.id,
      payload: {
        settlementId: row.id,
        botId: bot.id,
        period: period.toString(),
        collected: collected.toString(),
        due: due.toString(),
        status,
        entryId,
      },
      actor: `user:${bot.userId}`,
    })
  }

  return { settlement: { ...row, attempted, collected, status, entryId } }
}

/**
 * Stop a bot, and settle it on the way out.
 *
 * Stopping lives here rather than in `src/bots.ts` because it is a settlement event that happens to
 * change a status: the last chance to bill a bot's gain is the moment it leaves the running set, and
 * after that its equity stops being maintained.
 *
 * ## Two deliberate differences from the frozen stop route
 *
 * **It does not liquidate.** `crucible/services/crucible/src/routes/bots.ts` sells the position
 * first, so its `equity` is realised cash by the time it settles. Selling a user's holding because
 * they turned a bot off is a decision the user did not make — they keep the asset, and a service
 * that force-sells on stop is one nobody dares stop.
 *
 * **It therefore re-marks before it assesses.** Not liquidating means the equity would otherwise be
 * a mark from whenever the bot last ticked, and assessing against a stale mark is exactly what
 * `SettleScope` refuses to do for a paused bot. So this asks pricing for a current number first. If
 * pricing will not give one, the pass falls back to `arrears` — collect what is owed, assess
 * nothing — and the bot joins the sweep's second list, where the first pass that can get a price
 * will assess it. Under-collect, never over-collect: invariant 3's direction.
 *
 * The settle call is **one attempt, not the last word.** It can throw, and since invariant 4 it can
 * also return normally having charged nothing. Both used to be the end of the story, because the
 * frozen sweep walked only running bots and this bot has just left that set. `unsettledBotIds`
 * includes it, so "it will be retried" is a promise something keeps.
 */
export async function stopBot(
  deps: FeeDeps & {
    readonly ledger: LedgerClient
    readonly producer: string
    // The mark AND what it was taken against. The pair, because a stop is one of the three places
    // `bots.equity` is written and micro-org#368 is about a write that dropped the second half.
    readonly markEquity: (bot: BotRecord) => Promise<Mark | null>
  },
  bot: BotRecord,
): Promise<SettleOutcome> {
  // Status first. Whatever happens below, this bot must stop trading — a settlement that throws must
  // not leave a bot the operator asked to stop still ticking.
  await updateBot(deps.sql, bot.id, { status: 'stopped', stopped: true })

  if (bot.reservationEntryId !== null) {
    try {
      await deps.ledger.release(bot.reservationEntryId, {
        actor: 'service:trade',
        correlationId: deps.correlationId,
        idempotencyKey: `trade:release:${bot.id}`,
        description: `Release capital for bot ${bot.name}`,
      })
      await updateBot(deps.sql, bot.id, { reservationEntryId: null })
    } catch (err) {
      // A reservation that could not be released holds the user's capital out of reach. Logged
      // loudly and not thrown: the settlement below is the part that involves collecting money, and
      // an operator un-sticking a reservation is a smaller problem than a bot that would not stop.
      deps.logger.error('could not release the bot capital reservation', {
        botId: bot.id,
        reservationId: bot.reservationEntryId,
        err,
      })
    }
  }

  const marked = await deps.markEquity(bot)
  if (marked === null) {
    deps.logger.warn('no usable price at stop — reconciling arrears only, the sweep will assess later', {
      botId: bot.id,
    })
    return settle(deps, bot, 'arrears')
  }
  await updateBot(deps.sql, bot.id, { equity: marked.equity, equityPriceSource: marked.priceSource })
  return settle(deps, { ...bot, equity: marked.equity, equityPriceSource: marked.priceSource }, 'assess')
}
