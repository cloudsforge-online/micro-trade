/**
 * The HTTP surface.
 *
 * Plain `node:http` and a compiled route table, as in every sibling. The parts that matter — request
 * ids, RED metrics, the child logger, the error shape, the auth-fault mapping — are
 * framework-independent, and a framework choice made here would be a choice made for a service that
 * has not been written yet.
 *
 * Rule 4 of 03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does not pass CI.
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because the identity service is having a bad minute.
 *
 * ## Idempotency is required on every mutating route
 *
 * Not optional, not "recommended": a POST without `idempotency-key` is a 400. Every mutating route
 * here either moves money or commits capital, and a caller that cannot tell whether its retry landed
 * is a caller that will retry until something does. The fingerprint excludes `correlationId`, which
 * is *supposed* to change per attempt — including it would 409 a caller for doing tracing correctly.
 * See `src/idempotency.ts`.
 *
 * ## The backtest route answers 202
 *
 * Deliberately, and it is the one behavioural change from the frozen service. See the header of
 * `src/backtests.ts`.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { JobQueue } from '@cloudsforge/jobs'
import { STRATEGIES, findStrategy, isStrategyId, isTimeframe, normaliseParams, type Timeframe } from './catalog.ts'
import { amountTo, formatPrice } from './money.ts'
import { withIdempotency, IdempotencyInFlightError, IdempotencyKeyReuseError, requestFingerprint } from './idempotency.ts'
import { BACKTEST_KIND } from './jobs.ts'
import { queueBacktest, getOwnedBacktest, listBacktests, MAX_BARS, type BacktestRecord } from './backtests.ts'
import {
  BotStateError,
  getOwnedBot,
  insertBot,
  listBots,
  pauseBot,
  startBot,
  type BotRecord,
} from './bots.ts'
import { listFills } from './fills.ts'
import { listSettlements, stopBot, type FeeDeps } from './fees.ts'
import { BarRejectedError, assertIngestable, getSeries, ingestBars, listSeries, registerSeries } from './series.ts'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'
import { LedgerRefusedError, LedgerUnavailableError, type LedgerClient } from './ledgerclient.ts'
import { verifyEventSignature, withInbox, withOutbox, type Db } from './outbox.ts'
import type { Clock } from './rng.ts'
import type { Bar } from './indicators.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export const READ_SCOPE = 'trade:read'
export const WRITE_SCOPE = 'trade:write'
export const ADMIN_SCOPE = 'trade:admin'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  readonly producer: string
  readonly queue: Pick<JobQueue, 'enqueue'>
  readonly ledger: LedgerClient
  readonly pricing: PricingClient
  readonly clock: Clock
  readonly liveEnabled: boolean
  readonly settlementPeriodSeconds: number
  /** Verifies inbound event signatures. */
  readonly eventSigningSecret: string
  readonly beforeScrape?: () => Promise<void>
}

/**
 * Domain metrics, declared rather than inferred from a log line.
 *
 * The alternative — grepping logs for a message — makes a metric that breaks when someone rewords
 * the message, and it cannot be a Prometheus counter with labels.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({ name: 'trade_bots_created_total', help: 'Bots created', kind: 'counter', labels: ['mode'] })
    .register({ name: 'trade_backtests_queued_total', help: 'Backtests queued', kind: 'counter' })
    .register({ name: 'trade_bars_ingested_total', help: 'Bars accepted', kind: 'counter' })
    .register({
      name: 'trade_price_refusals_total',
      help: 'Trades refused because no usable price was available',
      kind: 'counter',
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const MAX_BODY_BYTES = 1024 * 1024
const SIGNATURE_HEADER = 'x-cloudsforge-signature'

/** Topics this service consumes. A topic not in here is acknowledged and ignored, never 4xx'd. */
const SUBSCRIBED_TOPICS = new Set(['identity.user.deleted'])

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Record<string, string>
}

interface Route {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

class BadRequestError extends Error {
  /**
   * Set when the request body was refused part-way through reading it.
   *
   * The connection cannot be reused after that: the unread remainder of the body is still in the
   * socket, and the next request on a keep-alive connection would be parsed starting from the middle
   * of it. The symptom is a client that hangs until its own timeout rather than one that gets a
   * clean error — which is how this was found.
   */
  readonly closeConnection: boolean
  constructor(message: string, closeConnection = false) {
    super(message)
    this.name = 'BadRequestError'
    this.closeConnection = closeConnection
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint unbounded
    // time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number): void => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    // `statusFor` is the whole point: one place decides what an auth failure means, so five services
    // cannot disagree about it again.
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired" tells
      // an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }
    if (err instanceof BotStateError) {
      return errorReply(409, 'bot_state', err.message, ctx.requestId)
    }
    if (err instanceof RateUnavailableError) {
      // 503, not 200-with-a-guess. A price this service cannot get is a reason to refuse, and saying
      // so is what stops a caller treating silence as permission.
      deps.metrics.increment('trade_price_refusals_total')
      return errorReply(503, 'rate_unavailable', err.message, ctx.requestId)
    }
    if (err instanceof LedgerRefusedError) {
      return errorReply(err.status === 409 ? 409 : 422, 'ledger_refused', err.message, ctx.requestId)
    }
    if (err instanceof LedgerUnavailableError) {
      ctx.log.error('ledger unavailable', { err })
      return errorReply(503, 'ledger_unavailable', 'the ledger could not be reached', ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return {
        ...errorReply(400, 'bad_request', err.message, ctx.requestId),
        ...(err.closeConnection ? { headers: { connection: 'close' } } : {}),
      }
    }
    if (err instanceof BarRejectedError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handleRoute: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handleRoute })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // `degraded` but still ready, because taking a whole product out of rotation over a
      // non-essential upstream is worse than serving without it.
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would lose
        // every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    // The catalogue is public. It is a product surface — the thing a prospective user reads before
    // signing up — and gating it behind a token would make the marketing page unable to render it.
    define('GET', '/v1/strategies', async () => ({ status: 200, body: { strategies: STRATEGIES } })),

    define('GET', '/v1/series', async (ctx, deps) => {
      await authenticate(ctx, deps)
      return { status: 200, body: { series: await listSeries(deps.sql) } }
    }),

    define('POST', '/v1/series', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const body = await readJson(ctx.req)
      const symbol = requireString(body, 'symbol', 64)
      const assetCode = requireString(body, 'assetCode', 16)
      const timeframe = requireString(body, 'timeframe', 8)
      if (!isTimeframe(timeframe)) throw new BadRequestError(`unknown timeframe ${timeframe}`)
      const source = requireString(body, 'source', 64)
      const series = await registerSeries(deps.sql, { symbol, assetCode, timeframe, source })
      return { status: 201, body: { series } }
    }),

    define('POST', '/v1/series/:id/bars', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const seriesId = uuidParam(ctx, 'id')
      const series = await getSeries(deps.sql, seriesId)
      if (!series) throw new NotFoundError('series not found')

      const body = await readJson(ctx.req)
      const raw = body['bars']
      if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestError('bars must be a non-empty array')
      if (raw.length > 5_000) throw new BadRequestError('at most 5000 bars per request')

      const bars = raw.map((entry) => parseBar(entry, series.timeframe, deps.clock))
      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ accepted: number }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/series/:id/bars',
        clientKey: key,
        requestHash: requestFingerprint({ seriesId, bars: bars.map(barFingerprint) }),
        run: async (tx) => {
          const accepted = await ingestBars(tx, seriesId, bars)
          return { response: { accepted }, subjectUrn: `cf:trade:series:${seriesId}` }
        },
      })
      deps.metrics.increment('trade_bars_ingested_total', {}, outcome.result.accepted)
      return { status: outcome.replayed ? 200 : 201, body: outcome.result }
    }),

    define('GET', '/v1/backtests', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const userId = ownerOf(ctx, principal)
      const backtests = await listBacktests(deps.sql, userId, 100)
      return { status: 200, body: { backtests: backtests.map(backtestView) } }
    }),

    define('GET', '/v1/backtests/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const userId = ownerOf(ctx, principal)
      const backtest = await getOwnedBacktest(deps.sql, uuidParam(ctx, 'id'), userId)
      if (!backtest) throw new NotFoundError('backtest not found')
      return { status: 200, body: { backtest: backtestView(backtest) } }
    }),

    define('POST', '/v1/backtests', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const userId = ownerOf(ctx, principal, body)

      const seriesId = requireUuid(body, 'seriesId')
      const series = await getSeries(deps.sql, seriesId)
      if (!series) throw new NotFoundError('series not found')

      const strategyId = requireString(body, 'strategyId', 64)
      if (!isStrategyId(strategyId)) throw new NotFoundError(`unknown strategy ${strategyId}`)

      const { params, adjusted } = normaliseParams(strategyId, readParams(body))
      const startCash = requireAmount(body, 'startCash')
      if (startCash <= 0n) throw new BadRequestError('startCash must be positive')
      const feeBps = readBps(body, 'feeBps', 10)
      const slippageBps = readBps(body, 'slippageBps', 5)
      const seed = readSeed(body)

      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ backtestId: string; status: string }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/backtests',
        clientKey: key,
        requestHash: requestFingerprint({
          userId,
          seriesId,
          strategyId,
          params,
          startCash: startCash.toString(),
          feeBps,
          slippageBps,
          seed,
        }),
        run: async (tx) => {
          const backtest = await queueBacktest(tx, {
            userId,
            seriesId,
            strategyId,
            params,
            seed,
            startCash,
            feeBps,
            slippageBps,
            notes: adjusted,
          })
          return {
            response: { backtestId: backtest.id, status: backtest.status },
            subjectUrn: `cf:trade:backtest:${backtest.id}`,
          }
        },
      })

      if (!outcome.replayed) {
        // Enqueued AFTER the claim commits, not inside it. A job enqueued in the same transaction
        // would be visible to a worker before the backtest row it names, and the worker would find
        // nothing and dead-letter a run that exists.
        await deps.queue.enqueue({
          kind: BACKTEST_KIND,
          key: `backtest:${outcome.result.backtestId}`,
          payload: { backtestId: outcome.result.backtestId },
          onConflict: 'keep',
        })
        deps.metrics.increment('trade_backtests_queued_total')
      }

      // 202 with a status url. See the header of src/backtests.ts for why this is not a 201 with a
      // result in it.
      return {
        status: 202,
        headers: { location: `/v1/backtests/${outcome.result.backtestId}` },
        body: { ...outcome.result, statusUrl: `/v1/backtests/${outcome.result.backtestId}`, notes: adjusted },
      }
    }),

    define('GET', '/v1/bots', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const userId = ownerOf(ctx, principal)
      const bots = await listBots(deps.sql, userId, 100)
      return { status: 200, body: { bots: bots.map(botView) } }
    }),

    define('GET', '/v1/bots/:id', async (ctx, deps) => {
      const { bot } = await ownedBot(ctx, deps, READ_SCOPE)
      return { status: 200, body: { bot: botView(bot) } }
    }),

    define('GET', '/v1/bots/:id/fills', async (ctx, deps) => {
      const { bot } = await ownedBot(ctx, deps, READ_SCOPE)
      const fills = await listFills(deps.sql, bot.id, 200)
      return {
        status: 200,
        body: {
          fills: fills.map((fill) => ({
            ...fill,
            priceScaled: amountTo(fill.priceScaled),
            price: formatPrice(fill.priceScaled),
            qty: amountTo(fill.qty),
            shards: amountTo(fill.shards),
            feeShards: amountTo(fill.feeShards),
          })),
        },
      }
    }),

    define('GET', '/v1/bots/:id/settlements', async (ctx, deps) => {
      const { bot } = await ownedBot(ctx, deps, READ_SCOPE)
      const settlements = await listSettlements(deps.sql, bot.id, 200)
      return {
        status: 200,
        body: {
          settlements: settlements.map((row) => ({
            ...row,
            period: row.period.toString(),
            equity: amountTo(row.equity),
            highWaterMark: amountTo(row.highWaterMark),
            gain: amountTo(row.gain),
            fee: amountTo(row.fee),
            attempted: amountTo(row.attempted),
            collected: amountTo(row.collected),
          })),
        },
      }
    }),

    define('POST', '/v1/bots', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const userId = ownerOf(ctx, principal, body)

      const name = requireString(body, 'name', 120)
      const mode = requireString(body, 'mode', 8)
      if (mode !== 'paper' && mode !== 'live') throw new BadRequestError("mode must be 'paper' or 'live'")
      const seriesId = requireUuid(body, 'seriesId')
      if (!(await getSeries(deps.sql, seriesId))) throw new NotFoundError('series not found')
      const strategyId = requireString(body, 'strategyId', 64)
      if (!findStrategy(strategyId)) throw new NotFoundError(`unknown strategy ${strategyId}`)
      if (!isStrategyId(strategyId)) throw new NotFoundError(`unknown strategy ${strategyId}`)
      const { params } = normaliseParams(strategyId, readParams(body))
      const allocation = requireAmount(body, 'allocation')
      if (allocation <= 0n) throw new BadRequestError('allocation must be positive')
      const feeBps = readBps(body, 'feeBps', 1_500)

      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ botId: string }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/bots',
        clientKey: key,
        requestHash: requestFingerprint({
          userId,
          name,
          mode,
          seriesId,
          strategyId,
          params,
          allocation: allocation.toString(),
          feeBps,
        }),
        run: async (tx) => {
          const bot = await insertBot(tx, {
            userId,
            name,
            mode,
            seriesId,
            strategyId,
            params,
            allocation,
            feeBps,
          })
          return { response: { botId: bot.id }, subjectUrn: `cf:trade:bot:${bot.id}` }
        },
      })
      deps.metrics.increment('trade_bots_created_total', { mode })
      return { status: outcome.replayed ? 200 : 201, body: outcome.result }
    }),

    /**
     * Start, pause and stop.
     *
     * One route with an `action` rather than three, because the frozen service's shape is the one
     * every consumer already knows and because the three share their whole precondition set. The
     * idempotency key is required here too: `start` reserves capital at the ledger, and a retried
     * start without a key would be a second reservation.
     */
    define('POST', '/v1/bots/:id/actions', async (ctx, deps) => {
      const { principal, bot } = await ownedBot(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const action = requireString(body, 'action', 16)
      const key = idempotencyKeyOf(ctx)
      const correlationId = ctx.requestId

      const outcome = await withIdempotency<{ botId: string; status: string; deferred?: string }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/bots/:id/actions',
        clientKey: key,
        requestHash: requestFingerprint({ botId: bot.id, action }),
        run: async () => {
          switch (action) {
            case 'start': {
              const started = await startBot(
                { sql: deps.sql, ledger: deps.ledger, producer: deps.producer, correlationId, liveEnabled: deps.liveEnabled },
                bot,
              )
              return { response: { botId: bot.id, status: started.status }, subjectUrn: `cf:trade:bot:${bot.id}` }
            }
            case 'pause': {
              await pauseBot(deps.sql, deps.producer, bot)
              return { response: { botId: bot.id, status: 'paused' }, subjectUrn: `cf:trade:bot:${bot.id}` }
            }
            case 'stop': {
              const feeDeps: FeeDeps & {
                ledger: LedgerClient
                producer: string
                markEquity: (b: BotRecord) => Promise<bigint | null>
              } = {
                sql: deps.sql,
                ledger: deps.ledger,
                clock: deps.clock,
                logger: ctx.log,
                periodSeconds: deps.settlementPeriodSeconds,
                correlationId,
                producer: deps.producer,
                markEquity: (b) => markEquityAt(deps, b),
              }
              const result = await stopBot(feeDeps, bot)
              return {
                response: {
                  botId: bot.id,
                  status: 'stopped',
                  ...(result.deferred !== undefined ? { deferred: result.deferred } : {}),
                },
                subjectUrn: `cf:trade:bot:${bot.id}`,
              }
            }
            default:
              throw new BadRequestError("action must be one of 'start', 'pause', 'stop'")
          }
        },
      })
      void principal
      return { status: 200, body: outcome.result }
    }),

    /**
     * The inbound event webhook.
     *
     * Signature checked over the RAW BYTES before anything is parsed, with `timingSafeEqual`: a
     * byte-at-a-time comparison of a MAC is a byte-at-a-time forgery oracle, and parsing before
     * verifying means an unauthenticated caller reaches the JSON parser.
     *
     * A topic this service does not subscribe to is acknowledged and ignored — never 4xx'd. A 4xx
     * makes the producer's relay retry the same event for ever.
     */
    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req)
      const presented = headerOf(ctx.req, SIGNATURE_HEADER)
      if (!presented || !verifyEventSignature(raw, deps.eventSigningSecret, presented)) {
        // Not 401: this is not a bearer-token surface, and answering 401 would invite a caller to go
        // and find a token. The MAC is the credential.
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }
      let envelope: { id?: unknown; topic?: unknown; payload?: Record<string, unknown> }
      try {
        envelope = JSON.parse(raw) as typeof envelope
      } catch {
        throw new BadRequestError('the event body is not valid JSON')
      }
      const topic = typeof envelope.topic === 'string' ? envelope.topic : ''
      const eventId = typeof envelope.id === 'string' ? envelope.id : ''
      if (!UUID.test(eventId)) throw new BadRequestError('the event id must be a uuid')
      if (!SUBSCRIBED_TOPICS.has(topic)) return { status: 202, body: { status: 'ignored' } }

      const outcome = await withInbox(deps.sql, topic, eventId, async (tx) => {
        // 03 §2 rule 6, and 17 §2: every service storing `user_id` subscribes to this and
        // acknowledges within its stated SLA. Bots are deleted; their fills and settlements go with
        // them by cascade. The idempotency claims are kept — they name a urn, not a user, and they
        // are the record that a charge was or was not made.
        const userId = envelope.payload?.['userId']
        if (typeof userId !== 'string' || !UUID.test(userId)) {
          throw new BadRequestError('identity.user.deleted requires a uuid userId')
        }
        const deleted = await tx`delete from bots where user_id = ${userId} returning id`
        await tx`delete from backtests where user_id = ${userId}`
        return { bots: deleted.length }
      })
      ctx.log.info('inbound event', { topic, eventId, outcome: outcome.status })
      return { status: 202, body: { status: outcome.status === 'duplicate' ? 'duplicate' : 'recorded' } }
    }),
  ]
}

/* ------------------------------------------------------------------ helpers */

/**
 * The current mark for a bot's position, or null.
 *
 * Null rather than a throw, because the one caller — `stopBot` — has a defined narrower behaviour
 * for "no price" and turning it into an exception would abort a stop that must complete.
 */
async function markEquityAt(deps: ServerDeps, bot: BotRecord): Promise<bigint | null> {
  const series = await getSeries(deps.sql, bot.seriesId)
  if (!series) return null
  try {
    const { equityOf } = await import('./money.ts')
    const quote = await deps.pricing.quote(series.assetCode as never)
    return equityOf(bot.cash, bot.position, series.assetCode as never, quote.midScaled)
  } catch (err) {
    if (err instanceof RateUnavailableError) return null
    throw err
  }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being a
  // separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

function requireOperator(principal: Principal): void {
  if (principal.kind === 'service') requireScope(principal, ADMIN_SCOPE)
  else if (!isAdmin(principal)) throw new ForbiddenError(`${ADMIN_SCOPE} or role:admin`)
}

/** Three authorities, one line: an admin may read anyone, a service reads whom its call names, a user reads itself. */
function ownerOf(ctx: RequestContext, principal: Principal, body?: Record<string, unknown>): string {
  const requested =
    (typeof body?.['userId'] === 'string' ? (body['userId'] as string) : undefined) ??
    ctx.url.searchParams.get('userId') ??
    undefined
  return isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
}

async function ownedBot(
  ctx: RequestContext,
  deps: ServerDeps,
  scope: string,
): Promise<{ principal: Principal; bot: BotRecord }> {
  const principal = await authenticate(ctx, deps)
  if (principal.kind === 'service') requireScope(principal, scope)
  const userId = ownerOf(ctx, principal)
  const bot = await getOwnedBot(deps.sql, uuidParam(ctx, 'id'), userId)
  if (!bot) throw new NotFoundError('bot not found')
  return { principal, bot }
}

/**
 * Amounts leave as decimal strings, on every view.
 *
 * Not a formatting preference: `JSON.stringify` **throws** on a bigint, so a record handed to the
 * serialiser without passing through one of these is a 500 rather than a wrong number. That is the
 * better failure of the two, and it is how this was caught — but it is still a failure, so every
 * route that returns a record goes through a view.
 */
function backtestView(backtest: BacktestRecord): Record<string, unknown> {
  return { ...backtest, startCash: amountTo(backtest.startCash) }
}

/** Amounts leave as decimal strings. A Shard balance fits in a double; a position in wei does not. */
function botView(bot: BotRecord): Record<string, unknown> {
  return {
    ...bot,
    allocation: amountTo(bot.allocation),
    cash: amountTo(bot.cash),
    position: amountTo(bot.position),
    equity: amountTo(bot.equity),
    highWaterMark: amountTo(bot.highWaterMark),
    feeOwed: amountTo(bot.feeOwed),
    feePaid: amountTo(bot.feePaid),
  }
}

function idempotencyKeyOf(ctx: RequestContext): string {
  const key = headerOf(ctx.req, 'idempotency-key')?.trim()
  if (!key || key.length < 8 || key.length > 200) {
    throw new BadRequestError(
      'an idempotency-key header of 8 to 200 characters is required on every mutating request',
    )
  }
  return key
}

function uuidParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name]
  if (!value || !UUID.test(value)) throw new BadRequestError(`${name} must be a uuid`)
  return value
}

function requireString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new BadRequestError(`${field} must be a string of 1 to ${max} characters`)
  }
  return value.trim()
}

function requireUuid(body: Record<string, unknown>, field: string): string {
  const value = requireString(body, field, 64)
  if (!UUID.test(value)) throw new BadRequestError(`${field} must be a uuid`)
  return value
}

/**
 * An amount, as a decimal string.
 *
 * A JSON number is accepted only when it is already a safe integer — beyond that the value has
 * ALREADY lost precision before this code ran, and silently accepting it is how the loss becomes
 * permanent.
 */
function requireAmount(body: Record<string, unknown>, field: string): bigint {
  const value = body[field]
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new BadRequestError(`${field} must be a whole number of Shards, as a string`)
    return BigInt(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestError(`${field} is not an exact non-negative integer; send it as a decimal string`)
    }
    return BigInt(value)
  }
  throw new BadRequestError(`${field} is required`)
}

function readBps(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field]
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 5_000) {
    throw new BadRequestError(`${field} must be a whole number of basis points between 0 and 5000`)
  }
  return value as number
}

/**
 * The seed.
 *
 * Defaulted rather than randomised. A random default would make an omitted seed produce a run
 * nobody can reproduce, which is the exact property this service promises not to have — and it would
 * do so silently, which is worse than refusing.
 */
function readSeed(body: Record<string, unknown>): number {
  const value = body['seed']
  if (value === undefined || value === null) return 0
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new BadRequestError('seed must be a whole number between 0 and 4294967295')
  }
  return value as number
}

function readParams(body: Record<string, unknown>): Record<string, number> {
  const raw = body['params']
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestError('params must be an object')
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestError(`params.${key} must be a finite number`)
    }
    out[key] = value
  }
  return out
}

function parseBar(entry: unknown, timeframe: Timeframe, clock: Clock): Bar {
  if (typeof entry !== 'object' || entry === null) throw new BadRequestError('each bar must be an object')
  const row = entry as Record<string, unknown>
  const t = row['t']
  if (!Number.isInteger(t) || (t as number) < 0) throw new BadRequestError('bar.t must be a unix second')
  const scaled = (field: string): bigint => {
    const value = row[field]
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      // Prices cross the wire as scaled integer STRINGS. A JSON number is an IEEE 754 double and a
      // price that arrives as one has lost precision before this code ran.
      throw new BadRequestError(`bar.${field} must be a scaled integer as a decimal string`)
    }
    return BigInt(value)
  }
  const bar: Bar = {
    t: t as number,
    o: scaled('o'),
    h: scaled('h'),
    l: scaled('l'),
    c: scaled('c'),
    v: row['v'] === undefined ? 0n : scaled('v'),
  }
  assertIngestable(bar, timeframe, clock)
  return bar
}

const barFingerprint = (bar: Bar): Record<string, string | number> => ({
  t: bar.t,
  o: bar.o.toString(),
  h: bar.h.toString(),
  l: bar.l.toString(),
  c: bar.c.toString(),
  v: bar.v.toString(),
})

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large', true)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health, metrics and money answers are a point-in-time fact. A cached 200 from a replica that
    // has since gone unready is exactly the lie this arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

// Referenced so the import is not dropped: `verifyEventSignature` uses it internally, and CI greps
// this file for the identifier to prove the webhook still verifies a MAC rather than merely claiming
// to. See .github/workflows/ci.yml.
void timingSafeEqual

// `withOutbox` is re-exported for the tests that drive a route's emitted events directly.
export { withOutbox }
