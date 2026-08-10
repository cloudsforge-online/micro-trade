/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. **There is no
 * `setInterval` in this repository**, and CI greps for one. The frozen service runs two
 * (`crucible/services/crucible/src/runner.ts` and), each guarded only by a module-local
 * boolean (`let running = false` at `runner.ts`, `let settling = false` at `runner.ts`) — a variable that by construction cannot
 * be seen by a second process, which is why that service cannot be scaled past one replica and why
 * its settlement sweep races its own stop route at one replica.
 *
 * ## The lease keys
 *
 * **The lease key names the contended resource, not the row.** This is the single decision most
 * likely to be got wrong by someone extending this file, and it is where the correctness lives.
 * Ask: what would break if two of these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work            | Key                | What two of them would do                              |
 *   |-----------------|--------------------|--------------------------------------------------------|
 *   | outbox.relay    | `stream`           | Deliver the same batch to the same subscriber twice.    |
 *   | bot.tick.sweep  | `stream`           | Enqueue every tick twice — harmless, since `bot.tick`   |
 *   |                 |                    | dedupes on its own key, but twice the write load.       |
 *   | bot.tick        | `bot:<id>`         | Two evaluations of one bot, each seeing the other's     |
 *   |                 |                    | pre-trade state. 04 §10.5 names this key.               |
 *   | bot.settle.sweep| `stream`           | As above.                                               |
 *   | bot.settle      | `bot:<id>:<period>`| **Double-billed performance fees.** 04 §10.5 names this |
 *   |                 |                    | key too, and 14 §5 makes it a mandatory test.           |
 *   | backtest.run    | `backtest:<id>`    | Two runs racing to write one `result_digest`.           |
 *   | idempotency.reap| `stream`           | Two long DELETEs contending on the same rows.           |
 *   | exchange.maintain.sweep | `stream`   | Enqueue every market twice — deduped by the key below,  |
 *   |                 |                    | so wasteful rather than wrong.                          |
 *   | exchange.maintain | `market:<id>`    | **The market row lock.** Two of them serialise behind   |
 *   |                 |                    | it and the second finds nothing to do, so this key buys |
 *   |                 |                    | throughput rather than safety — the safety is the lock. |
 *   | exchange.transfer.sweep | `stream`   | As above.                                               |
 *   | exchange.transfer | `transfer:<id>`  | Two ledger posts for one transfer. The derived key      |
 *   |                 |                    | makes the second a replay, so again wasteful not wrong. |
 *   | ratelimit.reap  | `stream`           | Two long DELETEs contending on the same rows.           |
 *
 * Note `bot.settle`'s key carries the period. That is not decoration: `(kind, key)` is unique, so
 * within one period the sweep can enqueue as often as it likes and exactly one settlement job
 * exists. It is the same fact `fee_settlements_bot_period_uniq` states in the schema, arranged so
 * the second attempt never even starts rather than merely failing safely.
 *
 * A `stream` key is this file's word for "there is exactly one of these". `(kind, key)` is unique
 * and the kind is half of it, so two different singletons keyed `stream` are still two rows; the
 * key only has work to do where a kind has many instances.
 *
 * ## The exchange jobs run whether or not the exchange is enabled
 *
 * `TRADE_EXCHANGE_ENABLED` gates the ROUTES — whether new orders and new transfers are accepted. It
 * deliberately does not gate the two jobs below, because the case that matters is the flag being
 * turned OFF: at that moment there can be a good-till-date order that still has to expire and a
 * withdrawal that has already debited a customer's balance and not yet reached the ledger. A flag
 * that stopped maintenance would strand both, and the second one is somebody's money. Turning the
 * exchange off stops it taking on new obligations; it does not abandon the ones it has.
 *
 * On a deployment that has never had the flag on both sweeps are two indexed queries against empty
 * tables, which is the price of that property and is not worth optimising away.
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import { Logger } from '@cloudsforge/telemetry'
import { createRelay, withOutbox, type Db, type RelayDeps } from './outbox.ts'
import { reapIdempotencyKeys } from './idempotency.ts'
import { getBot, runningBotIds, tickBot, unsettledBotIds, type TickDeps } from './bots.ts'
import { getSeries } from './series.ts'
import { periodFor, settle, type FeeDeps } from './fees.ts'
import { runBacktest } from './backtests.ts'
import { maintainMarket } from './exchange.ts'
import { marketsNeedingMaintenance } from './orders.ts'
import { getTransferById, openTransfers, settleTransfer } from './transfers.ts'
import { reapRateLimits } from './ratelimit.ts'
import type { LedgerClient } from './ledgerclient.ts'
import type { Clock } from './rng.ts'

export const RELAY_KIND = 'outbox.relay'
export const TICK_SWEEP_KIND = 'bot.tick.sweep'
export const TICK_KIND = 'bot.tick'
export const SETTLE_SWEEP_KIND = 'bot.settle.sweep'
export const SETTLE_KIND = 'bot.settle'
export const BACKTEST_KIND = 'backtest.run'
export const REAP_KIND = 'idempotency.reap'
export const MAINTAIN_SWEEP_KIND = 'exchange.maintain.sweep'
export const MAINTAIN_KIND = 'exchange.maintain'
export const TRANSFER_SWEEP_KIND = 'exchange.transfer.sweep'
export const TRANSFER_KIND = 'exchange.transfer'
export const RATE_REAP_KIND = 'ratelimit.reap'

/** Bots one sweep pass will enqueue. A ceiling, so one pass cannot become an unbounded transaction. */
const SWEEP_LIMIT = 500

/**
 * How long a transfer is left to the request that booked it before the sweep picks it up.
 *
 * Longer than `TRADE_MONEY_DEADLINE_MS` (5s by default) plus the time it takes to apply the outcome,
 * so a request that is merely slow is not raced by the job that exists for requests that DIED.
 */
const TRANSFER_ADOPTION_MS = 30_000

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * below plus the reschedule on completion — so the interval survives a restart, is visible in a
 * table an operator can query, and is claimed by exactly one replica.
 */
export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  { kind: TICK_SWEEP_KIND, key: 'stream', everyMs: 5_000 },
  { kind: SETTLE_SWEEP_KIND, key: 'stream', everyMs: 60_000 },
  { kind: REAP_KIND, key: 'stream', everyMs: 86_400_000 },
  // Five seconds is the resolution of a good-till-date expiry and of a stop that only the last trade
  // in a market can fire. Both are promises to a customer about a price, so the interval is the
  // worst case for how late either can be, and it is chosen against that rather than against load.
  { kind: MAINTAIN_SWEEP_KIND, key: 'stream', everyMs: 5_000 },
  { kind: TRANSFER_SWEEP_KIND, key: 'stream', everyMs: 30_000 },
  // Every window this deletes has been closed for at least five minutes, so nothing is urgent; the
  // interval is set by how big the table is allowed to get between passes, not by correctness.
  { kind: RATE_REAP_KIND, key: 'stream', everyMs: 300_000 },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success *after*
 * the handler returns, so a self-enqueue would be deleted a moment later and the schedule would
 * stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling a
 * job that has failed its full attempt budget hides a permanent fault behind a busy loop.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind}|${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind}|${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly queue: Pick<JobQueue, 'enqueue'>
  readonly logger: Logger
  readonly signingSecret: string
  readonly producer: string
  readonly idempotencyTtlDays: number
  /** Everything a tick needs, minus the per-job correlation id. */
  readonly tick: Omit<TickDeps, 'correlationId'>
  /** Everything a settlement needs, minus the per-job correlation id. */
  readonly fees: Omit<FeeDeps, 'correlationId'>
  /**
   * What the order book's maintenance needs.
   *
   * Its own pair rather than a reach into `fees`, even though both hold the same two objects today.
   * `fees.clock` is the clock a performance-fee PERIOD is computed against; sharing it here would
   * make a test that freezes one of them silently freeze the other, which is the kind of coupling
   * that is discovered by a test that cannot be made to fail.
   */
  readonly exchange: {
    readonly clock: Clock
    readonly ledger: LedgerClient
  }
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  /**
   * The tick producer.
   *
   * A sweep that enqueues, rather than a sweep that ticks. The frozen loop evaluates every running
   * bot serially inside one pass (`crucible/services/crucible/src/runner.ts`), so one slow
   * bot delays every other bot behind it and the whole pass is one process's work. Enqueuing means
   * the fleet is worked by every replica at once, and a bot that is wedged holds up only itself.
   */
  runner.register(TICK_SWEEP_KIND, async (_job, ctx) => {
    const ids = await runningBotIds(deps.sql, SWEEP_LIMIT)
    for (const id of ids) {
      if (ctx.signal.aborted) return
      // `keep`, so a bot still holding an un-run tick from the last sweep is not re-armed earlier.
      await deps.queue.enqueue({ kind: TICK_KIND, key: `bot:${id}`, payload: { botId: id }, onConflict: 'keep' })
    }
  })

  runner.register<{ botId?: string }>(TICK_KIND, async (job: Job<{ botId?: string }>, ctx) => {
    const botId = job.payload.botId
    if (typeof botId !== 'string' || botId.length === 0) {
      // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt budget
      // and dead-letters it, which is correct — retrying will not make the payload valid.
      throw new Error(`${TICK_KIND} requires a string botId`)
    }
    const bot = await getBot(deps.sql, botId)
    // A bot that has been deleted or stopped is not an error: the sweep enqueued it a moment before
    // it changed, and dead-lettering here would page somebody for a normal race.
    if (!bot || bot.status !== 'running') return
    const series = await getSeries(deps.sql, bot.seriesId)
    if (!series) {
      deps.logger.error('bot names a series that does not exist', { botId, seriesId: bot.seriesId })
      return
    }
    if (ctx.signal.aborted) return
    const result = await tickBot({ ...deps.tick, correlationId: `job:${job.id}` }, bot, series)
    deps.logger.info('bot tick', { botId, result })
  })

  /**
   * The settlement producer.
   *
   * Two lists, and the difference between them is the whole safety of the second one. A running bot
   * is ASSESSED: its equity is marked every tick, so the gain above its mark is current and billable.
   * A bot that has left the running set is RECONCILED only. See `SettleScope` in `src/fees.ts`.
   *
   * Keyed by `bot:<id>:<period>`, so the scope is carried in the payload rather than in the key: a
   * bot that stops between the two queries within one period must still get exactly one settlement
   * job, and the narrower scope is the safe one to keep.
   */
  runner.register(SETTLE_SWEEP_KIND, async (_job, ctx) => {
    const period = periodFor(deps.fees.clock, deps.fees.periodSeconds)
    const scopes = new Map<string, 'assess' | 'arrears'>()
    for (const id of await runningBotIds(deps.sql, SWEEP_LIMIT)) scopes.set(id, 'assess')
    for (const id of await unsettledBotIds(deps.sql, SWEEP_LIMIT)) scopes.set(id, 'arrears')

    for (const [botId, scope] of scopes) {
      if (ctx.signal.aborted) return
      await deps.queue.enqueue({
        kind: SETTLE_KIND,
        key: `bot:${botId}:${period}`,
        payload: { botId, scope },
        onConflict: 'keep',
      })
    }
  })

  runner.register<{ botId?: string; scope?: string }>(SETTLE_KIND, async (job, ctx) => {
    const botId = job.payload.botId
    if (typeof botId !== 'string' || botId.length === 0) {
      throw new Error(`${SETTLE_KIND} requires a string botId`)
    }
    const bot = await getBot(deps.sql, botId)
    if (!bot) return
    // Paper bots are free. Nothing about a simulation is billable, and reaching the ledger for one
    // would put a simulation in the journal.
    if (bot.mode !== 'live') return
    if (ctx.signal.aborted) return

    const scope = job.payload.scope === 'assess' ? 'assess' : 'arrears'
    const outcome = await withOutbox(deps.sql, deps.producer, async (_tx, emit) =>
      settle({ ...deps.fees, correlationId: `job:${job.id}` }, bot, scope, emit),
    )
    // A deferral is the sweep doing nothing, on purpose, and it has to be visible or it is
    // indistinguishable from the sweep never reaching the bot at all. It is also the only signal for
    // the one case that can repeat for ever: a stopped bot whose arrears no wallet can cover.
    if (outcome.deferred) {
      deps.logger.warn('fee settlement deferred — the sweep will ask again next period', {
        botId,
        scope,
        reason: outcome.deferred,
      })
    }
  })

  runner.register<{ backtestId?: string }>(BACKTEST_KIND, async (job, ctx) => {
    const backtestId = job.payload.backtestId
    if (typeof backtestId !== 'string' || backtestId.length === 0) {
      throw new Error(`${BACKTEST_KIND} requires a string backtestId`)
    }
    if (ctx.signal.aborted) return
    const result = await runBacktest({ sql: deps.sql, logger: deps.logger }, backtestId)
    deps.logger.info('backtest run', { backtestId, result })
  })

  runner.register(REAP_KIND, async () => {
    const removed = await reapIdempotencyKeys(deps.sql, deps.idempotencyTtlDays)
    if (removed > 0) deps.logger.info('reaped idempotency keys', { removed })
  })

  /* ---------------------------------------------------------------- the order book */

  /**
   * The maintenance producer.
   *
   * It asks the ORDERS table which markets have work rather than enqueuing every market, so on a
   * quiet exchange this pass costs one indexed query and enqueues nothing. The alternative — one job
   * per market every five seconds — takes and releases seven market locks a minute to discover there
   * is nothing to do, and gets worse with every symbol listed.
   */
  runner.register(MAINTAIN_SWEEP_KIND, async (_job, ctx) => {
    const due = await marketsNeedingMaintenance(
      deps.sql,
      new Date(deps.exchange.clock.now()),
      SWEEP_LIMIT,
    )
    for (const marketId of due) {
      if (ctx.signal.aborted) return
      await deps.queue.enqueue({
        kind: MAINTAIN_KIND,
        key: `market:${marketId}`,
        payload: { marketId },
        onConflict: 'keep',
      })
    }
  })

  /**
   * Expire what has timed out and fire what the market has moved past.
   *
   * This is the GUARANTEE behind both, not the usual path: a stop is normally promoted synchronously
   * by the trade that moved the price past it, inside the same transaction and under the same lock.
   * That path is bounded (`MAX_TRIGGER_ROUNDS`), and it is also unreachable in the one case that
   * matters most — a market whose last trade fired a stop and then had no further trades at all.
   * Without this job that stop waits for a stranger to place an order.
   */
  runner.register<{ marketId?: string }>(MAINTAIN_KIND, async (job, ctx) => {
    const marketId = job.payload.marketId
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error(`${MAINTAIN_KIND} requires a string marketId`)
    }
    if (ctx.signal.aborted) return
    const outcome = await maintainMarket(
      { sql: deps.sql, clock: deps.exchange.clock },
      marketId,
    )
    if (outcome.expired > 0 || outcome.triggered > 0) {
      deps.logger.info('market maintained', { marketId, ...outcome })
    }
  })

  /**
   * The transfer producer.
   *
   * Every transfer here is one a request abandoned — the process died between booking the row and
   * hearing back from the ledger, or the ledger's answer was unknown. Both leave real money in a
   * state nobody has resolved: a deposit whose wallet may already be debited, or a withdrawal whose
   * exchange balance certainly is. The sweep is the only thing that finishes them.
   */
  runner.register(TRANSFER_SWEEP_KIND, async (_job, ctx) => {
    const olderThan = new Date(deps.exchange.clock.now() - TRANSFER_ADOPTION_MS)
    for (const transfer of await openTransfers(deps.sql, olderThan, SWEEP_LIMIT)) {
      if (ctx.signal.aborted) return
      await deps.queue.enqueue({
        kind: TRANSFER_KIND,
        key: `transfer:${transfer.id}`,
        payload: { transferId: transfer.id },
        onConflict: 'keep',
      })
    }
  })

  /**
   * Ask the ledger about one transfer again.
   *
   * `settleTransfer` is safe to call any number of times for one row: the ledger idempotency key is
   * derived from the row's id so a repeat replays the same entry rather than moving money twice, and
   * the apply is a conditional UPDATE so the second caller claims nothing. That is what makes this a
   * retry rather than a second transfer, and it is the whole reason the row is written before the
   * ledger is called.
   *
   * A row that has since settled or been refused is re-read as terminal and skipped, which is the
   * normal outcome when the request that booked it finished a moment after the sweep saw it.
   */
  runner.register<{ transferId?: string }>(TRANSFER_KIND, async (job, ctx) => {
    const transferId = job.payload.transferId
    if (typeof transferId !== 'string' || transferId.length === 0) {
      throw new Error(`${TRANSFER_KIND} requires a string transferId`)
    }
    const transfer = await getTransferById(deps.sql, transferId)
    if (!transfer) return
    if (transfer.status !== 'pending' && transfer.status !== 'unresolved') return
    if (ctx.signal.aborted) return
    const outcome = await settleTransfer(
      { sql: deps.sql, ledger: deps.exchange.ledger, correlationId: `job:${job.id}` },
      transfer,
    )
    // `unresolved` repeating is the one state that can go on for ever, and it is the state in which
    // a customer's withdrawal is debited and not paid. It has to be visible from the log rather than
    // only from the row, because nobody queries a table they do not know to look at.
    if (outcome.status === 'unresolved') {
      deps.logger.warn('transfer is still unresolved — the ledger has not given an answer', {
        transferId,
        direction: transfer.direction,
        asset: transfer.asset,
      })
    } else {
      deps.logger.info('transfer resolved by the sweep', { transferId, status: outcome.status })
    }
  })

  runner.register(RATE_REAP_KIND, async () => {
    const removed = await reapRateLimits(deps.sql, deps.exchange.clock.now())
    if (removed > 0) deps.logger.info('reaped rate-limit windows', { removed })
  })

  return runner
}
