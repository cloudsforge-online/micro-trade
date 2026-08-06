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
 *
 * Note `bot.settle`'s key carries the period. That is not decoration: `(kind, key)` is unique, so
 * within one period the sweep can enqueue as often as it likes and exactly one settlement job
 * exists. It is the same fact `fee_settlements_bot_period_uniq` states in the schema, arranged so
 * the second attempt never even starts rather than merely failing safely.
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import { Logger } from '@cloudsforge/telemetry'
import { createRelay, withOutbox, type Db, type RelayDeps } from './outbox.ts'
import { reapIdempotencyKeys } from './idempotency.ts'
import { getBot, runningBotIds, tickBot, unsettledBotIds, type TickDeps } from './bots.ts'
import { getSeries } from './series.ts'
import { periodFor, settle, type FeeDeps } from './fees.ts'
import { runBacktest } from './backtests.ts'

export const RELAY_KIND = 'outbox.relay'
export const TICK_SWEEP_KIND = 'bot.tick.sweep'
export const TICK_KIND = 'bot.tick'
export const SETTLE_SWEEP_KIND = 'bot.settle.sweep'
export const SETTLE_KIND = 'bot.settle'
export const BACKTEST_KIND = 'backtest.run'
export const REAP_KIND = 'idempotency.reap'

/** Bots one sweep pass will enqueue. A ceiling, so one pass cannot become an unbounded transaction. */
const SWEEP_LIMIT = 500

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

  return runner
}
