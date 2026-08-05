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
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
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
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a connection
  // string ends up in a log the collector cannot parse.
  onnotice: () => {},
})
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

// 7. Routes. After the Lifecycle so the health handlers report real state, and after the pool so the
//    stores are real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: SERVICE,
  queue: { enqueue: (options) => queue.enqueue(options) },
  ledger,
  pricing,
  clock: systemClock,
  liveEnabled: env.liveEnabled,
  settlementPeriodSeconds: env.settlementPeriodSeconds,
  // Signing stays singular (the relay below); ACCEPTING is a list, so the estate's shared secret
  // can be rotated with an overlap window instead of a flag day. Unset, this is exactly
  // `[OUTBOX_SIGNING_SECRET]`, which is today's behaviour byte for byte.
  eventAcceptSecrets: env.acceptSecrets,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 8. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to the
//    Lifecycle for exactly that.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: db,
  queue,
  logger,
  signingSecret: env.outboxSigningSecret,
  producer: SERVICE,
  idempotencyTtlDays: IDEMPOTENCY_TTL_DAYS,
  tick: {
    sql: db,
    ledger,
    pricing,
    clock: systemClock,
    logger: logger.child({ job: 'bot.tick' }),
    producer: SERVICE,
    liveEnabled: env.liveEnabled,
  },
  fees: {
    sql: db,
    ledger,
    clock: systemClock,
    logger: logger.child({ job: 'bot.settle' }),
    periodSeconds: env.settlementPeriodSeconds,
  },
})
await seedRecurring(queue)
runner.start()

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
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
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
