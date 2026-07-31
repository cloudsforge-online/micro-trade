/**
 * Bots: the lifecycle, and the tick.
 *
 * **Ported from `crucible/services/crucible/src/runner.ts`**, with the one structural change the
 * whole repository exists for: there is no timer here. A tick is a leased job keyed `bot:<id>`
 * (04 §10.5 names the key), claimed `for update skip locked`, so two replicas are safe by
 * construction rather than by a module-local `let running = false` — which is a variable that by
 * construction cannot be seen by a second process, and is the frozen service's only guard
 * (`crucible/services/crucible/src/runner.ts:61`, `:380-383`).
 *
 * ## What a tick may and may not write
 *
 * A tick writes `state`, `last_bar_t`, `last_tick_at`, `last_error` and `equity`. It **does not
 * write `cash` or `position`** — those move only inside `applyFill`, in the same transaction as the
 * fill row being claimed.
 *
 * That split is the fix for 04 §11's named defect. The frozen `tickBot` computes cash and position
 * in memory and writes them alongside an advanced bar pointer
 * (`crucible/services/crucible/src/runner.ts:186-196`), so a crash between the money moving and that
 * write leaves money moved and a mirror that says it did not — permanently, because the pointer has
 * gone past the bar. Here the money movement carries its own bar pointer implicitly (the fill row
 * exists, and `fills_bot_bar_side_uniq` will not allow a second), and a crash before the tick's own
 * write costs one re-evaluation that finds the bar already filled.
 *
 * ## Where the clock and the price come from
 *
 * Both are parameters. `Clock` is injected so staleness is testable without moving the machine
 * clock; the price comes from `PricingClient`, which **throws** rather than defaulting. A bot that
 * cannot be priced does not trade — 07 §2 marks pricing a hard dependency in exactly those words.
 */

import { Logger } from '@cloudsforge/telemetry'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import {
  BPS_SCALE,
  applyBps,
  amountFrom,
  equityOf,
  slippedPrice,
  unitsForShards,
  valueInShards,
} from './money.ts'
import { compileSignals } from './strategies.ts'
import { isStrategyId, type StrategyId, type StrategyParams, type Timeframe } from './catalog.ts'
import { loadBars, stalenessIntervals, type SeriesRecord } from './series.ts'
import { bookFill, settleFill, applyFill, type FillSide, type PlannedFill } from './fills.ts'
import { RateUnavailableError, priceForSide, type PricingClient } from './pricingclient.ts'
import type { LedgerClient } from './ledgerclient.ts'
import type { Clock } from './rng.ts'
import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'

/** Bars fetched per evaluation — enough to warm up the longest indicator in the catalogue. */
export const LOOKBACK = 500

/**
 * Rebalances smaller than this share of equity are not worth the cost.
 *
 * 50 bps live against 20 bps in the backtest, and the asymmetry is deliberate: a live fill crosses a
 * real spread, so the threshold at which a rebalance stops paying for itself is higher than in a
 * simulation. Both numbers are the frozen service's (`runner.ts:36`, `backtest.ts:32`).
 */
const MIN_REBALANCE_BPS = 50n

/**
 * How stale the newest bar may be before a bot refuses to act.
 *
 * Trading on a price that stopped updating an hour ago is worse than not trading: the signal is
 * computed from a market that has moved on, and in live mode it settles against an oracle that has
 * not.
 */
const MAX_BAR_AGE_INTERVALS = 3

/**
 * Paper execution costs, matched to the backtest's defaults on purpose.
 *
 * Paper used to convert at the raw rate and book a zero fee in the frozen service, so a paper bot
 * beat the backtest of its own rule every time — "which is the single comparison this product exists
 * to let somebody make" (`crucible/services/crucible/src/runner.ts:217-226`). The two agree here by
 * construction rather than by two sets of numbers happening to match.
 */
export const PAPER_FEE_BPS = 10
export const PAPER_SLIPPAGE_BPS = 5

/**
 * What a live bot is told when the kill switch is off underneath it.
 *
 * Surfaced on the bot rather than only logged: a live bot that has gone quiet because an operator
 * pulled the switch is indistinguishable from one whose rule simply has not fired.
 */
export const LIVE_DISABLED =
  'live trading is switched off on this deployment — this bot is not trading'

export type BotMode = 'paper' | 'live'
export type BotStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'errored'

export interface BotRecord {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly mode: BotMode
  readonly status: BotStatus
  readonly seriesId: string
  readonly strategyId: StrategyId
  readonly params: StrategyParams
  readonly allocation: bigint
  readonly reservationEntryId: string | null
  readonly cash: bigint
  readonly position: bigint
  readonly equity: bigint
  readonly highWaterMark: bigint
  readonly feeBps: number
  readonly feeOwed: bigint
  readonly feePaid: bigint
  readonly state: Record<string, number>
  readonly lastBarT: number | null
  readonly lastError: string | null
}

interface BotRow {
  readonly id: string
  readonly user_id: string
  readonly name: string
  readonly mode: string
  readonly status: string
  readonly series_id: string
  readonly strategy_id: string
  readonly params: Record<string, number>
  readonly allocation: string
  readonly reservation_entry_id: string | null
  readonly cash: string
  readonly position: string
  readonly equity: string
  readonly high_water_mark: string
  readonly fee_bps: number
  readonly fee_owed: string
  readonly fee_paid: string
  readonly state: Record<string, number>
  readonly last_bar_t: string | number | null
  readonly last_error: string | null
}

const COLUMNS = `id, user_id, name, mode, status, series_id, strategy_id, params, allocation,
  reservation_entry_id, cash, position, equity, high_water_mark, fee_bps, fee_owed, fee_paid,
  state, last_bar_t, last_error`

export function toBot(row: BotRow): BotRecord {
  if (!isStrategyId(row.strategy_id)) {
    // A row naming a rule no branch implements cannot be evaluated, and pretending otherwise would
    // make it tick for ever producing nothing. 17 §8: no SKU without a delivery path.
    throw new Error(`bot ${row.id} names an unknown strategy ${row.strategy_id}`)
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    mode: row.mode as BotMode,
    status: row.status as BotStatus,
    seriesId: row.series_id,
    strategyId: row.strategy_id,
    params: row.params,
    allocation: amountFrom(row.allocation),
    reservationEntryId: row.reservation_entry_id,
    cash: amountFrom(row.cash),
    position: amountFrom(row.position),
    equity: amountFrom(row.equity),
    highWaterMark: amountFrom(row.high_water_mark),
    feeBps: row.fee_bps,
    feeOwed: amountFrom(row.fee_owed),
    feePaid: amountFrom(row.fee_paid),
    state: row.state,
    lastBarT: row.last_bar_t === null ? null : Number(row.last_bar_t),
    lastError: row.last_error,
  }
}

/* ------------------------------------------------------------------ the store */

export interface CreateBotInput {
  readonly userId: string
  readonly name: string
  readonly mode: BotMode
  readonly seriesId: string
  readonly strategyId: StrategyId
  readonly params: StrategyParams
  readonly allocation: bigint
  readonly feeBps: number
}

export async function insertBot(sql: Db | Tx, input: CreateBotInput, emit?: Emit): Promise<BotRecord> {
  const rows = await sql<BotRow[]>`
    insert into bots (user_id, name, mode, series_id, strategy_id, params, allocation, cash, equity, fee_bps)
    values (
      ${input.userId}, ${input.name}, ${input.mode}, ${input.seriesId}, ${input.strategyId},
      ${sql.json(input.params as Record<string, never>)}, ${input.allocation.toString()},
      ${input.allocation.toString()}, ${input.allocation.toString()}, ${input.feeBps}
    )
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('bot insert returned no row')
  const bot = toBot(row)
  emit?.({
    topic: 'trade.bot.created',
    key: bot.id,
    payload: { botId: bot.id, mode: bot.mode, strategyId: bot.strategyId, allocation: bot.allocation.toString() },
    actor: `user:${bot.userId}`,
  })
  return bot
}

export async function getBot(sql: Db, id: string): Promise<BotRecord | null> {
  const rows = await sql<BotRow[]>`select ${sql.unsafe(COLUMNS)} from bots where id = ${id}`
  const row = rows[0]
  return row ? toBot(row) : null
}

export async function getOwnedBot(sql: Db, id: string, userId: string): Promise<BotRecord | null> {
  const rows = await sql<BotRow[]>`
    select ${sql.unsafe(COLUMNS)} from bots where id = ${id} and user_id = ${userId}
  `
  const row = rows[0]
  return row ? toBot(row) : null
}

export async function listBots(sql: Db, userId: string, limit: number): Promise<readonly BotRecord[]> {
  const rows = await sql<BotRow[]>`
    select ${sql.unsafe(COLUMNS)} from bots where user_id = ${userId} order by created_at desc limit ${limit}
  `
  return rows.map(toBot)
}

/** Every running bot, for the tick producer. */
export async function runningBotIds(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from bots where status = 'running' order by created_at asc limit ${limit}
  `
  return rows.map((row) => row.id)
}

/**
 * Bots the settlement sweep must reach: running ones, plus any that have LEFT the running set still
 * owing something or holding an undecided row.
 *
 * The second list is the whole point, and the frozen service says why at
 * `crucible/services/crucible/src/runner.ts:441-449`: a bot is stopped at the moment of its FINAL
 * settlement, so it is the likeliest bot in the estate to be carrying an undecided row — and
 * sweeping only the running ones meant that row, and any arrears under it, were never looked at
 * again.
 */
export async function unsettledBotIds(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from bots where status <> 'running' and fee_owed > 0
    union
    select distinct b.id
      from bots b
      join fee_settlements s on s.bot_id = b.id and s.status = 'pending'
     where b.status <> 'running'
     limit ${limit}
  `
  return rows.map((row) => row.id)
}

export interface BotPatch {
  readonly status?: BotStatus
  readonly equity?: bigint
  readonly highWaterMark?: bigint
  readonly feeOwed?: bigint
  readonly feePaid?: bigint
  readonly state?: Record<string, number>
  readonly lastBarT?: number
  readonly lastError?: string | null
  readonly reservationEntryId?: string | null
  readonly touchTick?: boolean
  readonly started?: boolean
  readonly stopped?: boolean
}

/**
 * Patch a bot.
 *
 * Deliberately cannot write `cash` or `position` — there is no field for them. Those move only in
 * `applyFill`, in the same transaction as the fill row it claims. Making it impossible to express
 * here is cheaper than a comment asking people not to.
 */
export async function updateBot(sql: Db | Tx, id: string, patch: BotPatch): Promise<void> {
  const set: Record<string, unknown> = {}
  if (patch.status !== undefined) set['status'] = patch.status
  if (patch.equity !== undefined) set['equity'] = patch.equity.toString()
  if (patch.highWaterMark !== undefined) set['high_water_mark'] = patch.highWaterMark.toString()
  if (patch.feeOwed !== undefined) set['fee_owed'] = patch.feeOwed.toString()
  if (patch.feePaid !== undefined) set['fee_paid'] = patch.feePaid.toString()
  if (patch.state !== undefined) set['state'] = sql.json(patch.state as Record<string, never>)
  if (patch.lastBarT !== undefined) set['last_bar_t'] = patch.lastBarT
  if (patch.lastError !== undefined) set['last_error'] = patch.lastError
  if (patch.reservationEntryId !== undefined) set['reservation_entry_id'] = patch.reservationEntryId
  if (patch.touchTick) set['last_tick_at'] = new Date()
  if (patch.started) set['started_at'] = new Date()
  if (patch.stopped) set['stopped_at'] = new Date()
  if (Object.keys(set).length === 0) return
  await sql`update bots set ${sql(set)} where id = ${id}`
}

/* ------------------------------------------------------------------ the tick */

export interface Rebalance {
  readonly side: FillSide
  /** Shards to spend, on a buy. */
  readonly shards: bigint
  /** Base-asset units to sell, on a sell. */
  readonly units: bigint
}

/**
 * Turn a target exposure into a trade, or into nothing.
 *
 * All bigint. The frozen equivalent (`crucible/services/crucible/src/runner.ts:88-101`) does the
 * same arithmetic in floats and then `Math.floor`s the result, which is a rounding decision made
 * after the precision was already lost.
 */
export function planRebalance(
  targetBps: number,
  cash: bigint,
  units: bigint,
  asset: AssetCode,
  markScaled: bigint,
): Rebalance | null {
  if (markScaled <= 0n) return null
  const held = valueInShards(units, asset, markScaled)
  const equity = cash + held
  if (equity <= 0n) return null

  const clamped = BigInt(Math.max(0, Math.min(10_000, Math.trunc(targetBps))))
  const delta = (equity * clamped) / BPS_SCALE - held
  const magnitude = delta < 0n ? -delta : delta
  if (magnitude * BPS_SCALE < MIN_REBALANCE_BPS * equity) return null

  if (delta > 0n) {
    const shards = delta < cash ? delta : cash
    // Below one Shard there is nothing to trade: Shards have no sub-unit.
    return shards >= 1n ? { side: 'buy', shards, units: 0n } : null
  }
  const wanted = unitsForShards(-delta, asset, markScaled)
  const sell = wanted < units ? wanted : units
  return sell > 0n ? { side: 'sell', shards: 0n, units: sell } : null
}

export interface TickDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly pricing: PricingClient
  readonly clock: Clock
  readonly logger: Logger
  readonly producer: string
  readonly liveEnabled: boolean
  readonly correlationId: string
}

export type TickResult =
  | 'no_bars'
  | 'stale'
  | 'no_price'
  | 'live_disabled'
  | 'marked'
  | 'no_signal'
  | 'already_filled'
  | 'filled'
  | 'refused'
  | 'unresolved'
  | 'not_running'

/**
 * Evaluate one bot against the newest closed bar and act on its signal.
 *
 * Returns a verdict rather than throwing for the ordinary refusals, because "the market data is
 * behind" and "the strategy has no opinion" are not failures — they are the answer, and dressing
 * them up as exceptions would dead-letter a healthy bot within five attempts.
 */
export async function tickBot(
  deps: TickDeps,
  bot: BotRecord,
  series: SeriesRecord,
): Promise<TickResult> {
  if (bot.status !== 'running') return 'not_running'

  if (bot.mode === 'live' && !deps.liveEnabled) {
    await updateBot(deps.sql, bot.id, { touchTick: true, lastError: LIVE_DISABLED })
    return 'live_disabled'
  }

  const bars = await loadBars(deps.sql, bot.seriesId, LOOKBACK)
  if (bars.length < 2) {
    await updateBot(deps.sql, bot.id, { touchTick: true, lastError: 'no market data' })
    return 'no_bars'
  }
  const newest = bars[bars.length - 1]!
  const behind = stalenessIntervals(newest, series.timeframe, deps.clock)
  if (behind > MAX_BAR_AGE_INTERVALS) {
    await updateBot(deps.sql, bot.id, {
      touchTick: true,
      lastError: `market data is ${behind} bars behind — not trading on it`,
    })
    return 'stale'
  }

  const asset = series.assetCode as AssetCode

  // The mark. A paper bot marks at the bar's own close; a live bot marks at the same oracle a fill
  // will settle against, because marking a position at anything else would make the equity curve
  // disagree with the money.
  let markScaled: bigint
  let buyScaled: bigint
  let sellScaled: bigint
  if (bot.mode === 'paper') {
    markScaled = newest.c
    buyScaled = slippedPrice(newest.c, PAPER_SLIPPAGE_BPS, 'buy')
    sellScaled = slippedPrice(newest.c, PAPER_SLIPPAGE_BPS, 'sell')
  } else {
    try {
      const quote = await deps.pricing.quote(asset)
      markScaled = quote.midScaled
      buyScaled = priceForSide(quote, 'buy')
      sellScaled = priceForSide(quote, 'sell')
    } catch (err) {
      if (!(err instanceof RateUnavailableError)) throw err
      // Refused, not defaulted. This is the branch the "a stale price refuses the trade" test drives.
      await updateBot(deps.sql, bot.id, { touchTick: true, lastError: err.message })
      return 'no_price'
    }
  }

  // Nothing new has closed since the last evaluation: mark to market and stop. Re-running the signal
  // here would be harmless but pointless, and it would make the tick cost scale with the poll rate
  // instead of the bar rate.
  if (bot.lastBarT !== null && bot.lastBarT >= newest.t) {
    await updateBot(deps.sql, bot.id, {
      equity: equityOf(bot.cash, bot.position, asset, markScaled),
      touchTick: true,
      lastError: null,
    })
    return 'marked'
  }

  // Only the bars this bot has not already folded into its state are replayed. The rest of the
  // window warms the indicators up and is NOT this bot's history: folding it in made a bot's first
  // tick behave as though it had been running for 500 bars — a fresh DCA spent its whole allocation
  // at once because the window contained enough bars for every slice. See
  // `crucible/services/crucible/src/runner.ts:154-163`.
  const seen = bot.lastBarT
  const oldest = bars[0]!
  const continuous = seen !== null && seen >= oldest.t
  const from = continuous ? bars.findIndex((bar) => bar.t > seen) : bars.length - 1
  const { signals, state } = compileSignals(bot.strategyId, bot.params, bars, {
    state: bot.state,
    from: from < 0 ? bars.length : from,
  })

  const signal = signals[signals.length - 1]
  let verdict: TickResult = 'no_signal'
  let error: string | null = null

  if (signal && signal.target !== null) {
    const action = planRebalance(signal.target, bot.cash, bot.position, asset, markScaled)
    if (action) {
      const fillPrice = action.side === 'buy' ? buyScaled : sellScaled
      // The fee comes out of the same cash as the notional, so a buy has to leave room for it.
      // Spending all of it and paying the fee on top is how an account goes quietly negative — the
      // backtest caps for exactly this reason, and the frozen live path does not, which is why its
      // paper bots could drive `cash` below zero. Caught by bots.test.ts against the
      // `bots_amounts_non_negative` constraint.
      const feeBps = bot.mode === 'paper' ? PAPER_FEE_BPS : 0
      const affordable = (bot.cash * BPS_SCALE) / (BPS_SCALE + BigInt(feeBps))
      const spend = action.shards < affordable ? action.shards : affordable
      const notional = action.side === 'buy' ? spend : valueInShards(action.units, asset, fillPrice)
      const qty = action.side === 'buy' ? unitsForShards(notional, asset, fillPrice) : action.units
      const fee = applyBps(notional, feeBps)

      const planned: PlannedFill = {
        botId: bot.id,
        userId: bot.userId,
        barT: newest.t,
        side: action.side,
        mode: bot.mode,
        priceScaled: fillPrice,
        qty,
        // Signed. A buy costs the notional and the fee; a sell returns the notional less the fee.
        shards: action.side === 'buy' ? -(notional + fee) : notional - fee,
        feeShards: fee,
        reason: `${bot.strategyId}: ${signal.reason}`,
      }

      if (qty <= 0n) {
        verdict = 'no_signal'
      } else {
        const booked = await bookFill(deps.sql, planned)
        if (!booked) {
          // Already filled this side on this bar — a replay, not a failure.
          verdict = 'already_filled'
        } else if (bot.mode === 'paper') {
          // No ledger call: a paper fill moves imaginary money, and posting it would put a
          // simulation in the journal.
          const applied = await applyFill(deps.sql, booked.id, {
            priceScaled: planned.priceScaled,
            qty: planned.qty,
            shards: planned.shards,
            feeShards: planned.feeShards,
            entryId: null,
          })
          verdict = applied.status === 'applied' ? 'filled' : 'already_filled'
        } else {
          const outcome = await settleFill(
            { sql: deps.sql, ledger: deps.ledger, asset, correlationId: deps.correlationId },
            booked,
          )
          if (outcome.status === 'applied') verdict = 'filled'
          else if (outcome.status === 'already') verdict = 'already_filled'
          else {
            verdict = outcome.status
            error = outcome.reason
          }
        }
      }
    }
  }

  // Re-read, because `applyFill` moved cash and position in its own transaction and this function
  // must not compute equity from the snapshot it started with. That snapshot is exactly what the
  // frozen runner writes back, and 04 §11 names the divergence it causes.
  const fresh = (await getBot(deps.sql, bot.id)) ?? bot
  await updateBot(deps.sql, bot.id, {
    equity: equityOf(fresh.cash, fresh.position, asset, markScaled),
    state,
    lastBarT: newest.t,
    touchTick: true,
    lastError: error,
  })
  return verdict
}

/* ------------------------------------------------------------------ lifecycle */

export class BotStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BotStateError'
  }
}

/**
 * Start a bot.
 *
 * A live bot's capital becomes a **ledger reservation** before its status changes, and the schema
 * refuses a running live bot without one (`bots_live_capital_reserved`). The order matters: reserve,
 * then start. Reversed, a crash in between leaves a bot trading against capital nothing has set
 * aside.
 */
export async function startBot(
  deps: { sql: Db; ledger: LedgerClient; producer: string; correlationId: string; liveEnabled: boolean },
  bot: BotRecord,
): Promise<BotRecord> {
  if (bot.status === 'running') return bot
  if (bot.status === 'stopped') throw new BotStateError('a stopped bot cannot be restarted — create a new one')
  if (bot.mode === 'live' && !deps.liveEnabled) {
    throw new BotStateError(LIVE_DISABLED)
  }

  let reservationId = bot.reservationEntryId
  if (bot.mode === 'live' && reservationId === null) {
    const { allocationIdempotencyKey } = await import('./ledgerclient.ts')
    const reservation = await deps.ledger.reserve({
      subject: `user:${bot.userId}`,
      assetCode: 'SHARD',
      amount: bot.allocation,
      actor: 'service:trade',
      correlationId: deps.correlationId,
      idempotencyKey: allocationIdempotencyKey(bot.id),
      description: `Capital for bot ${bot.name}`,
    })
    reservationId = reservation.reservationId
  }

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    await updateBot(tx, bot.id, {
      status: 'running',
      reservationEntryId: reservationId,
      started: true,
      lastError: null,
      // The mark starts at the capital committed. Starting it at zero would bill the user a
      // performance fee on their own deposit the first time the bot was settled.
      highWaterMark: bot.highWaterMark > 0n ? bot.highWaterMark : bot.allocation,
    })
    emit({
      topic: 'trade.bot.started',
      key: bot.id,
      payload: { botId: bot.id, mode: bot.mode, reservationId },
      actor: `user:${bot.userId}`,
    })
    const rows = await tx<BotRow[]>`select ${tx.unsafe(COLUMNS)} from bots where id = ${bot.id}`
    return toBot(rows[0]!)
  })
}

/**
 * Pause a bot.
 *
 * **Pause is deliberately not a flatten.** The position stays open by design, which is why a paused
 * bot is only ever RECONCILED by the settlement sweep and never assessed — its equity is a
 * mark-to-market number from whenever it last ticked, against an unrealised position that may be
 * worth anything by now. See `SettleScope` in `src/fees.ts`.
 */
export async function pauseBot(sql: Db, producer: string, bot: BotRecord): Promise<void> {
  if (bot.status !== 'running') throw new BotStateError(`a ${bot.status} bot cannot be paused`)
  await withOutbox(sql, producer, async (tx, emit) => {
    await updateBot(tx, bot.id, { status: 'paused' })
    emit({ topic: 'trade.bot.paused', key: bot.id, payload: { botId: bot.id }, actor: `user:${bot.userId}` })
  })
}
