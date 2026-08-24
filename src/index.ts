/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a separate
 * one-shot process. See rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it must
 * not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql , networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { httpLedgerClient } from './ledgerclient.ts'
import { httpPricingClient } from './pricingclient.ts'
import { systemClock } from './rng.ts'
import type { Db } from './outbox.ts'

/** How long a claimed idempotency key is kept. Must outlive every caller's retry horizon. */
const IDEMPOTENCY_TTL_DAYS = 30

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the pool's
//    failure is a structured, searchable, redacted line rather than a bare V8 stack the collector
//    drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION, liveEnabled: env.liveEnabled })

// 3. The database pool. Opened before the schema assertion because the assertion is a query, and
//    before the Lifecycle because the readiness probe closes over it.
const poolOptions = {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a connection
  // string ends up in a log the collector cannot parse.
  onnotice: () => {},
}
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `TRADE_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined
const db = sql as unknown as Db

// 4. Assert the schema. This does **not** migrate. Failing here rather than serving is the point: a
//    replica of the new code answering requests against the old schema corrupts data quietly,
//    whereas a container that refuses to start is a deploy that visibly stops.
//
//    For this service that is more than hygiene. Below schema version 9 the
//    `fee_settlements_bot_period_uniq` constraint does not exist, and this code running against that
//    schema would double-bill performance fees exactly the way the service it supersedes does.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
//
//    ## Hard versus soft, and why only Postgres is hard
//
//    Readiness answers one question: should the load balancer send this replica traffic? So the test
//    for `hard` is not "is this dependency important" — every one of them is — it is "is there any
//    request this replica can still serve correctly without it".
//
//      * **Postgres — hard.** Without it there is no route that works, including a read. A replica
//        that cannot reach its own database is a replica that should be removed.
//      * **Ledger — soft.** It is a hard dependency of every *money* path (07 §2) and this service
//        refuses those individually: a fill that cannot post stays `unresolved`, a settlement stays
//        `pending`, and both are retried under the same key. But the strategy catalogue, the
//        backtest surface and every read still work, and delisting the whole service would take
//        those down for a reason that has nothing to do with them.
//      * **Pricing — soft, for the same reason.** 07 §2 calls it hard and it is, *per trade*: a bot
//        with no price does not trade, and `RateUnavailableError` is never caught and defaulted.
//        That refusal happens at the point of use, where it is precise. Delisting on it would stop
//        backtests, which do not consult pricing at all.
//      * **Identity JWKS — soft.** Marking it hard means one identity blip removes every service in
//        the estate from its balancer at once, which is a cascade, not a safety measure.
//
//    The deliberate consequence: this service reports `degraded` rather than `not ready` when an
//    upstream is down, and the per-request 503s are what tell a caller which operation is affected.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when the
  // process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores the
      // signal would hang `/readyz` for ever. Racing the signal here is what turns "the database is
      // not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('pricing', `${env.pricingUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('billing', `${env.billingUrl}/livez`, { kind: 'soft' }))

// 6. The upstream clients. One scoped credential, this service's own — SD-05: never shared with
//    another service, so a compromise of one is not a compromise of the estate.
const serviceToken = (): string => env.serviceToken
const ledger = httpLedgerClient({
  baseUrl: env.ledgerUrl,
  token: serviceToken,
  deadlineMs: env.moneyDeadlineMs,
  originatingService: SERVICE,
})
const pricing = httpPricingClient({
  baseUrl: env.pricingUrl,
  token: serviceToken,
  deadlineMs: env.upstreamDeadlineMs,
  clock: systemClock,
})

// ── ONE PLANE PER NETWORK ───────────────────────────────────────────────────────────────────
//
// Pool, handle and queue together. The QUEUE is per-network as much as the pool is: an enqueue is
// a WRITE, and a job claimed by a runner holding the other estate's handle applies to the other
// estate's rows and leaves a completed row behind saying it went exactly as intended.
const queueFor = (handle: typeof sql) =>
  new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId })

const planes = [
  { network: 'mainnet' as const, pool: sql, db, queue: queueFor(sql) },
  ...(sqlTestnet
    ? [{ network: 'testnet' as const, pool: sqlTestnet, db: sqlTestnet as unknown as Db, queue: queueFor(sqlTestnet) }]
    : []),
]
const planeFor = (network: 'mainnet' | 'testnet') => {
  const plane = planes.find((p) => p.network === network)
  if (!plane) throw new Error(`no plane for network ${network}`)
  return plane
}

// 7. Routes. After the Lifecycle so the health handlers report real state, and after the pool so the
//    stores are real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  sql: networkSql({
    mainnet: sql as unknown as RuntimeSql,
    ...(sqlTestnet ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  }),
  ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as 'mainnet' | 'testnet' } : {}),
  producer: SERVICE,
  // Boot-time value; `forRequest` replaces it with this request's network before any route sees
  // it. An enqueue is a WRITE, and a fill job claimed by the other estate's runner clears against
  // the other estate's book.
  queue: { enqueue: (options) => planeFor('mainnet').queue.enqueue(options) },
  queueFor: (network: 'mainnet' | 'testnet') => ({
    enqueue: (options: Parameters<JobQueue['enqueue']>[0]) => planeFor(network).queue.enqueue(options),
  }),
  ledger,
  pricing,
  clock: systemClock,
  liveEnabled: env.liveEnabled,
  // Gates the `/v1/exchange` ROUTES only. The jobs below run either way — see the header of
  // `src/jobs.ts` for why turning the book off must not strand a GTD order or a debited withdrawal.
  exchangeEnabled: env.exchangeEnabled,
  settlementPeriodSeconds: env.settlementPeriodSeconds,
  // Signing stays singular (the relay below); ACCEPTING is a list, so the estate's shared secret
  // can be rotated with an overlap window instead of a flag day. Unset, this is exactly
  // `[OUTBOX_SIGNING_SECRET]`, which is today's behaviour byte for byte.
  eventAcceptSecrets: env.acceptSecrets,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    // Per network. Summed across both queues the gauge reads healthy while one estate's
    // backlog grows for ever — micro-org#398 in another form.
    for (const plane of planes) {
      const stats = await plane.queue.stats()
      metrics.set('jobs_pending', stats.pending, { network: plane.network })
      metrics.set('jobs_overdue', stats.overdue, { network: plane.network })
    }
  },
})

// 8. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to the
//    Lifecycle for exactly that.
// ── ONE RUNNER PER NETWORK ──────────────────────────────────────────────────────────────────
//
// Bulkheaded deliberately. A single runner over a single queue would drain mainnet and leave the
// other estate's jobs to accumulate for ever, and every handler would hold the mainnet handle —
// so the work would apply to the wrong rows and record success.
const runners = planes.map((plane) => {
  const reschedule = rescheduleRecurring(plane.queue, logger)
  const runner = new JobRunner({
      queue: plane.queue,
    concurrency: 4,
    pollMs: 1_000,
    shouldClaim: () => lifecycle.claimingJobs,
    onEvent: (event) => {
      if (event.kind) {
        const labels = { kind: event.kind, network: plane.network }
        if (event.type === 'claimed') metrics.increment('jobs_claimed_total', labels)
        if (event.type === 'completed') metrics.increment('jobs_completed_total', labels)
        if (event.type === 'failed') metrics.increment('jobs_failed_total', labels)
        if (event.type === 'dead') metrics.increment('jobs_dead_total', labels)
        if (event.durationMs !== undefined) metrics.observe('jobs_duration_ms', event.durationMs, labels)
      }
      if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
        logger.error('job failure', { ...event })
      }
      reschedule(event)
    },
  })

  registerHandlers(runner, {
    sql: plane.db,
    queue: plane.queue,
    logger,
    signingSecret: env.outboxSigningSecret,
    producer: SERVICE,
    idempotencyTtlDays: IDEMPOTENCY_TTL_DAYS,
    tick: {
      sql: plane.db,
      ledger,
      pricing,
      clock: systemClock,
      logger: logger.child({ job: 'bot.tick' }),
      producer: SERVICE,
      liveEnabled: env.liveEnabled,
    },
    fees: {
      sql: plane.db,
      ledger,
      clock: systemClock,
      logger: logger.child({ job: 'bot.settle' }),
      periodSeconds: env.settlementPeriodSeconds,
    },
    // Not gated on `env.exchangeEnabled`, deliberately — see the header of `src/jobs.ts`. The flag
    // stops the exchange ACCEPTING work; maintenance of work it has already accepted must survive
    // being switched off, or a withdrawal that debited a customer stays debited and unpaid.
    exchange: { clock: systemClock, ledger },
  })
  return runner
})
// Seeded into EVERY queue: an estate with no recurring sweep is half-running, not dormant.
for (const plane of planes) await seedRecurring(plane.queue)
for (const runner of runners) runner.start()

// 9. Listen. Last of the construction steps, because a socket that accepts before its dependencies
//    exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 10. Ready. Only now: `/readyz` starts answering 200 and the balancer is allowed to send traffic.
lifecycle.markReady()

// 11. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot drains
//     a service that was never ready. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and drains, then the pool closes with nothing left to
//     use it.
lifecycle.onShutdown(async () => {
  await Promise.all(planes.map((plane) => plane.pool.end({ timeout: 5 })))
  logger.info('database pools closed', { networks: planes.length })
})
lifecycle.onShutdown(async () => {
  const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean)
  logger.info('job runners stopped', { clean, runners: runners.length })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
