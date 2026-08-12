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
import {
  queueBacktest,
  getOwnedBacktest,
  getOwnedBacktestResult,
  listBacktests,
  MAX_BARS,
  type BacktestRecord,
} from './backtests.ts'
import {
  BotStateError,
  LIVE_DISABLED,
  getOwnedBot,
  insertBot,
  listBots,
  pauseBot,
  startBot,
  type BotRecord,
  type Mark,
} from './bots.ts'
import { listFills } from './fills.ts'
import { listSettlements, stopBot, type FeeDeps } from './fees.ts'
import {
  EXCHANGE_DISABLED,
  OrderRejectedError,
  OrderStateError,
  PLACED_ORDER_TYPES,
  bestBidOffer,
  cancelAllOrdersIn,
  cancelOrder,
  isPlacedOrderType,
  marketDepth,
  placeOrderIn,
  validatePlacement,
  type DepthSnapshot,
  type PlaceOrderInput,
} from './exchange.ts'
import {
  baseUnitOf,
  getMarket,
  getMarketBySymbol,
  isMarketStatus,
  listMarkets,
  priceBand,
  setMarketStatus,
  type Market,
} from './markets.ts'
import { InsufficientFundsError, listBalances, type Balance } from './accounts.ts'
import {
  averagePrice,
  getOwnedOrder,
  listOrderEvents,
  listOrders,
  type OrderEventRecord,
  type OrderRecord,
} from './orders.ts'
import { STP_MODES, TIME_IN_FORCE, isSide, isStpMode, isTimeInForce } from './matching.ts'
import { RateLimitedError, enforceRate, type RateAction } from './ratelimit.ts'
import {
  bookTransfer,
  getTransferById,
  isTransferableAsset,
  listTransfers,
  settleTransfer,
  type TransferRecord,
} from './transfers.ts'
import {
  CANDLE_INTERVALS,
  candles,
  isCandleInterval,
  listOwnFills,
  ownFillOf,
  recentTrades,
  ticker,
  type Candle,
  type OwnFill,
  type PublicTrade,
  type Ticker,
} from './marketdata.ts'
import { BarRejectedError, assertIngestable, getSeries, ingestBars, listSeries, registerSeries } from './series.ts'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'
import { LedgerRefusedError, LedgerUnavailableError, type LedgerClient } from './ledgerclient.ts'
import { SIGNATURE_HEADER, verifyEventSignature, withInbox, withOutbox, type Db } from './outbox.ts'
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
  /**
   * Whether this deployment operates an order book at all.
   *
   * False by default. Not a feature toggle — see `EXCHANGE_DISABLED` in `src/exchange.ts` and R-54.
   */
  readonly exchangeEnabled: boolean
  readonly settlementPeriodSeconds: number
  /**
   * The secrets inbound event signatures are verified against, newest first.
   *
   * A list rather than a value so that rotating the estate's shared `OUTBOX_SIGNING_SECRET` has an
   * overlap window: a producer that has not been redeployed yet is still signing with the old key,
   * and refusing it would silently partition `identity.user.deleted` off this service. Signing is
   * unaffected — the relay keeps its single `signingSecret`.
   */
  readonly eventAcceptSecrets: readonly string[]
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
    .register({
      name: 'trade_orders_placed_total',
      help: 'Exchange orders accepted, by side and by the state they reached',
      kind: 'counter',
      labels: ['side', 'status'],
    })
    .register({
      name: 'trade_orders_rejected_total',
      help: 'Exchange orders refused before they existed, by reason code',
      kind: 'counter',
      labels: ['code'],
    })
    .register({
      name: 'trade_trades_total',
      help: 'Trades printed on the order book',
      kind: 'counter',
    })
    .register({
      name: 'trade_rate_limited_total',
      help: 'Requests refused by the rate limiter, by action',
      kind: 'counter',
      labels: ['action'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const MAX_BODY_BYTES = 1024 * 1024

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

/**
 * The order book is not running here.
 *
 * A distinct class rather than an inline 503 because every `/v1/exchange` route needs it and a
 * check repeated eighteen times is a check that will be forgotten on the nineteenth. `exchangeRoute`
 * below applies it once, at the point routes are declared, so a new route cannot be added without it.
 */
class ExchangeDisabledError extends Error {
  constructor() {
    super(EXCHANGE_DISABLED)
    this.name = 'ExchangeDisabledError'
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
    if (err instanceof ExchangeDisabledError) {
      // 503 rather than 404, because the routes exist and a deployment with the flag on serves
      // them. A 404 would tell a client the feature was never built, and it would keep telling it
      // that after an operator turned the flag on and restarted only some replicas.
      return errorReply(503, 'exchange_disabled', err.message, ctx.requestId)
    }
    if (err instanceof RateLimitedError) {
      deps.metrics.increment('trade_rate_limited_total', { action: err.action })
      return {
        ...errorReply(429, 'rate_limited', err.message, ctx.requestId),
        // The header is the machine-readable half. Without it a client's only strategy is to guess,
        // and the guess that costs least to write is the one that retries immediately.
        headers: { 'retry-after': String(err.retryAfterSeconds) },
      }
    }
    if (err instanceof OrderRejectedError) {
      // 422, not 400: the request was well-formed and understood. What was refused is the ORDER, on
      // a rule of the market it was sent to — a tick size, a price band, a minimum. `code` is the
      // stable half of the answer and is what the browser matches on to put the explanation beside
      // the control that is wrong; the message is prose and may be reworded.
      deps.metrics.increment('trade_orders_rejected_total', { code: err.code })
      return errorReply(422, err.code, err.message, ctx.requestId)
    }
    if (err instanceof OrderStateError) {
      return errorReply(409, 'order_state', err.message, ctx.requestId)
    }
    if (err instanceof InsufficientFundsError) {
      // 409, matching what this service already answers when the LEDGER refuses for the same reason
      // (`LedgerRefusedError` with status 409, just below). One fact, one status, wherever it is
      // discovered.
      return errorReply(409, 'insufficient_funds', err.message, ctx.requestId)
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

type RouteHandler = (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>

const define = (method: string, path: string, handleRoute: RouteHandler): Route => ({
  method,
  path,
  pattern: compile(path),
  handle: handleRoute,
})

/**
 * A route that only exists where the order book does.
 *
 * The flag is checked here, at declaration, rather than in each handler. Eighteen copies of one
 * `if` is eighteen chances to forget it, and the one that gets forgotten will be a mutating route —
 * a placement or a withdrawal — because those are the ones written last.
 */
const exchangeRoute = (method: string, path: string, handleRoute: RouteHandler): Route =>
  define(method, path, async (ctx, deps) => {
    if (!deps.exchangeEnabled) throw new ExchangeDisabledError()
    return handleRoute(ctx, deps)
  })

function buildRoutes(): Route[] {
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

    /**
     * What this deployment will actually let you do.
     *
     * `TRADE_LIVE_ENABLED` defaults to false, and nothing reported it. A customer could configure
     * a live bot, be charged for it, and discover only when it refused to tick that live trading
     * is switched off here — the client had no way to warn them beforehand, because there was no
     * way to ask.
     *
     * Public and unauthenticated, like the catalogue beside it: whether a deployment offers live
     * trading is a property of the deployment, not of the caller, and a signed-out visitor reading
     * the product page deserves the same true answer as a signed-in one. Nothing here is derived
     * from a user.
     *
     * The refusal string is `LIVE_DISABLED` verbatim — the same sentence the engine writes onto a
     * bot it declines to tick. One sentence, one source: a client that renders this is showing the
     * service's own words rather than a paraphrase that can drift from them.
     *
     * `orderBook` is the same arrangement for `TRADE_EXCHANGE_ENABLED`, and it carries the
     * vocabularies with it — the order types, the times in force, the self-trade modes, the candle
     * widths. The browser builds its controls from this rather than from a copy of the enums, so a
     * deployment that gains a new order type gains the control for it without a second release, and
     * a browser can never offer a choice the engine will refuse.
     */
    define('GET', '/v1/capabilities', async (_ctx, deps) => ({
      status: 200,
      body: {
        capabilities: {
          liveTrading: {
            enabled: deps.liveEnabled,
            ...(deps.liveEnabled ? {} : { refusal: LIVE_DISABLED }),
          },
          orderBook: {
            enabled: deps.exchangeEnabled,
            ...(deps.exchangeEnabled ? {} : { refusal: EXCHANGE_DISABLED }),
            orderTypes: PLACED_ORDER_TYPES,
            timeInForce: TIME_IN_FORCE,
            stpModes: STP_MODES,
            candleIntervals: Object.keys(CANDLE_INTERVALS),
          },
        },
      },
    })),

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

    /**
     * The equity curve and the fill list, which were computed, stored, and then served by nothing.
     *
     * Separate from `GET /v1/backtests/:id` so the summary stays cheap — see the note on
     * `getOwnedBacktestResult`. Same ownership rule as the summary: a backtest is scoped to its
     * owner in the query itself, not by a check after the fact.
     *
     * A run that has not completed is a 409 naming its state, not a 200 with empty arrays. An
     * empty fill list is a real answer — a strategy that never traded — and a client must be able
     * to tell "it did nothing" from "it has not finished yet".
     */
    define('GET', '/v1/backtests/:id/result', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const userId = ownerOf(ctx, principal)
      const result = await getOwnedBacktestResult(deps.sql, uuidParam(ctx, 'id'), userId)
      if (!result) throw new NotFoundError('backtest not found')
      if (result.status !== 'complete' || !result.fills || !result.equity) {
        return errorReply(
          409,
          'backtest_not_complete',
          `this backtest is ${result.status}; a result exists only once it completes`,
          ctx.requestId,
        )
      }
      return { status: 200, body: { fills: result.fills, equity: result.equity } }
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
            usdCents: amountTo(fill.usdCents),
            feeUsdCents: amountTo(fill.feeUsdCents),
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
                markEquity: (b: BotRecord) => Promise<Mark | null>
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

    ...exchangeRoutes(),

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
      if (!presented || !verifyEventSignature(raw, deps.eventAcceptSecrets, presented)) {
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

/* ------------------------------------------------------------------ the exchange */

/**
 * The order book's HTTP surface.
 *
 * Eighteen routes in one function rather than scattered through `buildRoutes`, because they share a
 * precondition (`exchangeRoute`), a rate-limiting scheme and a set of views, and because the whole
 * group is switched on and off together.
 *
 * ## What is read-only and what costs money
 *
 * Every route here needs a token. The market data is public in CONTENT — the tape carries no
 * counterparty — but not in ACCESS; see the header of `src/marketdata.ts` for why, and note that
 * the rate limiter has no subject to meter an anonymous caller by.
 *
 * ## Idempotency
 *
 * Every POST takes an `idempotency-key`, including `cancel-all`, which is *naturally* repeatable.
 * The key still earns its place there: a retried mass cancel that has already run finds nothing left
 * to cancel and would answer with an empty list, and "we cancelled nothing" is the wrong answer to
 * give somebody who just hit the panic button and lost their connection. The claim replays the
 * FIRST attempt's list.
 *
 * `DELETE /v1/exchange/orders/:id` is the one mutation with no key, and that is deliberate: the
 * order id in the path IS the idempotency key. A second delete of the same order is refused with a
 * 409 naming the state it is already in, which is information the caller needs — answering 200 to a
 * cancel that cancelled nothing is how somebody comes to believe they are flat when they are not.
 */
function exchangeRoutes(): Route[] {
  return [
    exchangeRoute('GET', '/v1/exchange/markets', async (ctx, deps) => {
      await reader(ctx, deps)
      const markets = await listMarkets(deps.sql)
      return { status: 200, body: { markets: markets.map(marketView) } }
    }),

    /**
     * One market, and everything a screen needs to open on it.
     *
     * Four facts in one response — the rules, the band, the top of the book, the day — because a
     * client that has to make four calls to draw one screen will make them in four different
     * moments and draw a market that never existed.
     */
    exchangeRoute('GET', '/v1/exchange/markets/:symbol', async (ctx, deps) => {
      await reader(ctx, deps)
      const market = await resolveMarket(deps, ctx.params['symbol'])
      const [bbo, day] = await Promise.all([
        bestBidOffer(deps.sql, market.id),
        ticker(deps.sql, market.id, deps.clock.now()),
      ])
      return {
        status: 200,
        body: {
          market: marketView(market),
          bbo: { bid: nullableAmount(bbo.bid), ask: nullableAmount(bbo.ask) },
          ticker: tickerView(day),
        },
      }
    }),

    exchangeRoute('GET', '/v1/exchange/markets/:symbol/depth', async (ctx, deps) => {
      await reader(ctx, deps)
      const market = await resolveMarket(deps, ctx.params['symbol'])
      const depth = await marketDepth(deps.sql, market.id, limitParam(ctx, 50, 500))
      return { status: 200, body: { marketId: market.id, symbol: market.symbol, depth: depthView(depth) } }
    }),

    exchangeRoute('GET', '/v1/exchange/markets/:symbol/ticker', async (ctx, deps) => {
      await reader(ctx, deps)
      const market = await resolveMarket(deps, ctx.params['symbol'])
      return { status: 200, body: { ticker: tickerView(await ticker(deps.sql, market.id, deps.clock.now())) } }
    }),

    exchangeRoute('GET', '/v1/exchange/markets/:symbol/trades', async (ctx, deps) => {
      await reader(ctx, deps)
      const market = await resolveMarket(deps, ctx.params['symbol'])
      const trades = await recentTrades(deps.sql, market.id, limitParam(ctx, 50, 500))
      return { status: 200, body: { marketId: market.id, trades: trades.map(publicTradeView) } }
    }),

    exchangeRoute('GET', '/v1/exchange/markets/:symbol/candles', async (ctx, deps) => {
      await reader(ctx, deps)
      const market = await resolveMarket(deps, ctx.params['symbol'])
      const interval = ctx.url.searchParams.get('interval') ?? '1m'
      if (!isCandleInterval(interval)) {
        throw new BadRequestError(`interval must be one of ${Object.keys(CANDLE_INTERVALS).join(', ')}`)
      }
      const rows = await candles(deps.sql, market.id, interval, limitParam(ctx, 200, 1_000))
      return { status: 200, body: { marketId: market.id, interval, candles: rows.map(candleView) } }
    }),

    /**
     * Place an order.
     *
     * The claim and the placement share ONE transaction — `placeOrderIn` exists for that — so there
     * is no instant in which a key is claimed for a trade that did not happen, or a trade happened
     * under a key that did not commit. The events go out on the same transaction through `emit`.
     *
     * Validated twice on purpose. Here, before a lock is taken, so a mistyped price costs a round
     * trip rather than a queue behind the market's lock; and again inside `placeOrderIn`, under the
     * lock, which is the check that actually decides — between the two, the market can halt and the
     * price band can move.
     */
    exchangeRoute('POST', '/v1/exchange/orders', async (ctx, deps) => {
      const principal = await writer(ctx, deps, 'order.place')
      const body = await readJson(ctx.req)
      const userId = ownerOf(ctx, principal, body)
      const market = await marketFromBody(deps, body)
      const input = placementFrom(userId, market, body, deps.clock)
      validatePlacement(market, input)

      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ order: Record<string, unknown>; fills: Record<string, unknown>[] }>(
        deps.sql,
        {
          originatingService: deps.producer,
          route: 'POST /v1/exchange/orders',
          clientKey: key,
          requestHash: requestFingerprint(placementFingerprint(input)),
          run: async (tx, _storedKey, emit) => {
            const result = await placeOrderIn(tx, emit, { sql: deps.sql, clock: deps.clock }, input)
            // Filtered to the caller's own side. A placement can print trades that belong to other
            // customers — a stop of theirs that this order's price fired — and those are not this
            // caller's to see.
            const fills = result.trades
              .map((trade) => ownFillOf(userId, trade))
              .filter((fill): fill is OwnFill => fill !== null)
              .map(fillView)
            return {
              response: { order: orderView(market, result.order), fills },
              subjectUrn: `cf:trade:order:${result.order.id}`,
            }
          },
        },
      )

      if (!outcome.replayed) {
        deps.metrics.increment('trade_orders_placed_total', {
          side: input.side,
          status: String(outcome.result.order['status'] ?? 'unknown'),
        })
        if (outcome.result.fills.length > 0) {
          deps.metrics.increment('trade_trades_total', {}, outcome.result.fills.length)
        }
      }
      return { status: outcome.replayed ? 200 : 201, body: outcome.result }
    }),

    exchangeRoute('GET', '/v1/exchange/orders', async (ctx, deps) => {
      const principal = await reader(ctx, deps)
      const userId = ownerOf(ctx, principal)
      const market = await marketFromQuery(deps, ctx)
      const orders = await listOrders(deps.sql, {
        userId,
        marketId: market?.id,
        open: ctx.url.searchParams.get('open') === 'true',
        limit: limitParam(ctx, 100, 500),
      })
      const symbols = await symbolIndex(deps, orders)
      return { status: 200, body: { orders: orders.map((order) => orderView(symbols.get(order.marketId) ?? null, order)) } }
    }),

    exchangeRoute('GET', '/v1/exchange/orders/:id', async (ctx, deps) => {
      const principal = await reader(ctx, deps)
      const userId = ownerOf(ctx, principal)
      const order = await getOwnedOrder(deps.sql, uuidParam(ctx, 'id'), userId)
      if (!order) throw new NotFoundError('order not found')
      return { status: 200, body: { order: orderView(await getMarket(deps.sql, order.marketId), order) } }
    }),

    /**
     * The order's own history: accepted, triggered, filled, reduced, cancelled, expired.
     *
     * Append-only and served verbatim. This is the surface that answers "why did my order do that",
     * and it answers it with what was written at the time rather than with a state machine's guess
     * reconstructed afterwards.
     */
    exchangeRoute('GET', '/v1/exchange/orders/:id/events', async (ctx, deps) => {
      const principal = await reader(ctx, deps)
      const userId = ownerOf(ctx, principal)
      const order = await getOwnedOrder(deps.sql, uuidParam(ctx, 'id'), userId)
      if (!order) throw new NotFoundError('order not found')
      const events = await listOrderEvents(deps.sql, order.id)
      return { status: 200, body: { orderId: order.id, events: events.map(orderEventView) } }
    }),

    exchangeRoute('DELETE', '/v1/exchange/orders/:id', async (ctx, deps) => {
      const principal = await writer(ctx, deps, 'order.cancel')
      const userId = ownerOf(ctx, principal)
      const order = await cancelOrder(
        { sql: deps.sql, clock: deps.clock },
        { userId, orderId: uuidParam(ctx, 'id') },
      )
      return { status: 200, body: { order: orderView(await getMarket(deps.sql, order.marketId), order) } }
    }),

    exchangeRoute('POST', '/v1/exchange/orders/cancel-all', async (ctx, deps) => {
      const principal = await writer(ctx, deps, 'order.cancel')
      const body = await readJson(ctx.req)
      const userId = ownerOf(ctx, principal, body)
      const market = body['marketId'] === undefined && body['symbol'] === undefined
        ? null
        : await marketFromBody(deps, body)
      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ cancelled: Record<string, unknown>[] }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/exchange/orders/cancel-all',
        clientKey: key,
        requestHash: requestFingerprint({ userId, marketId: market?.id ?? null }),
        run: async (tx) => {
          const cancelled = await cancelAllOrdersIn(tx, { userId, marketId: market?.id ?? null })
          return {
            response: { cancelled: cancelled.map((order) => orderView(market, order)) },
            subjectUrn: null,
          }
        },
      })
      return { status: 200, body: outcome.result }
    }),

    exchangeRoute('GET', '/v1/exchange/fills', async (ctx, deps) => {
      const principal = await reader(ctx, deps)
      const userId = ownerOf(ctx, principal)
      const market = await marketFromQuery(deps, ctx)
      const fills = await listOwnFills(deps.sql, userId, market?.id ?? null, limitParam(ctx, 100, 500))
      return { status: 200, body: { fills: fills.map(fillView) } }
    }),

    exchangeRoute('GET', '/v1/exchange/balances', async (ctx, deps) => {
      const principal = await reader(ctx, deps)
      const userId = ownerOf(ctx, principal)
      const balances = await listBalances(deps.sql, userId)
      return { status: 200, body: { balances: balances.map(balanceView) } }
    }),

    /**
     * Move money across the custody boundary.
     *
     * The claim commits FIRST and the ledger is called afterwards, which is the opposite of the
     * placement above and for a reason: the ledger is another service over the network, and holding
     * an open transaction — and the claim row's lock — for the duration of somebody else's request
     * is how one slow upstream becomes this service's outage. `bookTransfer` writes the row inside
     * the claim, so the intent is durable before anything is asked of the ledger, and the ledger key
     * is derived from that row's id so the call is a replay if it is made twice.
     *
     * The stored response is the transfer ID and nothing else, so a replay reads the CURRENT state
     * rather than the state at first submission. That also makes a client retry a recovery path: a
     * transfer that was left `pending` or `unresolved` by a crash is settled by the next retry of
     * the request that created it.
     */
    exchangeRoute('POST', '/v1/exchange/transfers', async (ctx, deps) => {
      const principal = await writer(ctx, deps, 'transfer.create')
      const body = await readJson(ctx.req)
      const userId = ownerOf(ctx, principal, body)
      const direction = requireString(body, 'direction', 16)
      if (direction !== 'deposit' && direction !== 'withdrawal') {
        throw new BadRequestError("direction must be 'deposit' or 'withdrawal'")
      }
      const asset = requireString(body, 'asset', 16).toUpperCase()
      if (!isTransferableAsset(asset)) throw new BadRequestError(`${asset} cannot be moved into exchange custody`)
      const amount = requireAmount(body, 'amount')
      if (amount <= 0n) throw new BadRequestError('amount must be positive')

      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ transferId: string }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/exchange/transfers',
        clientKey: key,
        requestHash: requestFingerprint({ userId, direction, asset, amount: amount.toString() }),
        run: async (tx) => {
          const booked = await bookTransfer(tx, direction, { userId, asset, amount })
          return { response: { transferId: booked.id }, subjectUrn: `cf:trade:transfer:${booked.id}` }
        },
      })

      const booked = await getTransferById(deps.sql, outcome.result.transferId)
      if (!booked) throw new NotFoundError('transfer not found')
      const settled =
        booked.status === 'pending' || booked.status === 'unresolved'
          ? await settleTransfer(
              { sql: deps.sql, ledger: deps.ledger, correlationId: ctx.requestId },
              booked,
            )
          : { status: booked.status, transfer: booked }
      return {
        status: outcome.replayed ? 200 : 201,
        body: {
          transfer: transferView(settled.transfer),
          // Stated separately from the record because it is the answer to "did my money move", and
          // `unresolved` in particular is a real outcome rather than a failure: the debit stands,
          // the job will ask the ledger again, and the customer must not be told either "done" or
          // "it failed" when neither is known.
          outcome: settled.status,
        },
      }
    }),

    exchangeRoute('GET', '/v1/exchange/transfers', async (ctx, deps) => {
      const principal = await reader(ctx, deps)
      const userId = ownerOf(ctx, principal)
      const transfers = await listTransfers(deps.sql, userId, limitParam(ctx, 100, 500))
      return { status: 200, body: { transfers: transfers.map(transferView) } }
    }),

    /**
     * Halt a market, or let it back up.
     *
     * Operator-only, and the one control here that is not a customer's. `cancel_only` and
     * `post_only` are the two that matter in an incident: the first lets everybody out without
     * letting anybody in, and the second lets a book be rebuilt without anyone crossing a spread
     * that has not settled down yet.
     */
    exchangeRoute('POST', '/v1/exchange/markets/:symbol/status', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const market = await resolveMarket(deps, ctx.params['symbol'])
      const body = await readJson(ctx.req)
      const status = requireString(body, 'status', 16)
      if (!isMarketStatus(status)) throw new BadRequestError(`status must be one of ${MARKET_STATUS_LIST}`)
      const key = idempotencyKeyOf(ctx)
      const outcome = await withIdempotency<{ market: Record<string, unknown> }>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /v1/exchange/markets/:symbol/status',
        clientKey: key,
        requestHash: requestFingerprint({ marketId: market.id, status }),
        run: async () => {
          const updated = await setMarketStatus(deps.sql, market.id, status)
          if (!updated) throw new NotFoundError('market not found')
          return { response: { market: marketView(updated) }, subjectUrn: `cf:trade:market:${market.id}` }
        },
      })
      ctx.log.info('market status changed', { marketId: market.id, status })
      return { status: 200, body: outcome.result }
    }),
  ]
}

const MARKET_STATUS_LIST = 'active, post_only, cancel_only, halted'

/**
 * A reader: authenticated, scoped, and metered.
 *
 * The rate limit is consumed for reads as well as writes because the depth and candle routes are the
 * cheapest thing in the world to put in a loop and the most expensive thing here to serve.
 */
async function reader(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const principal = await authenticate(ctx, deps)
  if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
  await enforceRate(deps.sql, 'market.read', rateSubject(principal), deps.clock.now())
  return principal
}

/** A writer: authenticated, scoped, and metered against the action it is about to perform. */
async function writer(ctx: RequestContext, deps: ServerDeps, action: RateAction): Promise<Principal> {
  const principal = await authenticate(ctx, deps)
  if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
  await enforceRate(deps.sql, action, rateSubject(principal), deps.clock.now())
  return principal
}

/**
 * Who a rate limit counts against.
 *
 * The authenticated principal, never the IP: behind a load balancer every request shares one address
 * and limiting by it limits the balancer. A service is namespaced so that a busy backend cannot eat
 * a customer's quota, or be starved by one.
 */
function rateSubject(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : `service:${principal.service}`
}

/**
 * A market named either way.
 *
 * The path segment takes a uuid or a symbol, because the id is what a machine has and the symbol is
 * what a person has, and requiring a lookup call before every other call would be a worse API than
 * one regex.
 */
async function resolveMarket(deps: ServerDeps, raw: string | undefined): Promise<Market> {
  if (!raw) throw new BadRequestError('a market symbol or id is required')
  const market = UUID.test(raw)
    ? await getMarket(deps.sql, raw)
    : await getMarketBySymbol(deps.sql, raw)
  if (!market) throw new NotFoundError(`no market ${raw}`)
  return market
}

async function marketFromBody(deps: ServerDeps, body: Record<string, unknown>): Promise<Market> {
  const named = body['marketId'] ?? body['symbol']
  if (typeof named !== 'string') throw new BadRequestError('name the market by marketId or by symbol')
  return resolveMarket(deps, named.trim())
}

/** The optional `?market=` filter, as a market or nothing. */
async function marketFromQuery(deps: ServerDeps, ctx: RequestContext): Promise<Market | null> {
  const named = ctx.url.searchParams.get('market') ?? ctx.url.searchParams.get('marketId')
  return named ? resolveMarket(deps, named) : null
}

/**
 * The markets a page of orders belongs to, fetched once each.
 *
 * A per-order lookup would be N queries to put a symbol on a list, and the list is the busiest read
 * surface the exchange has.
 */
async function symbolIndex(deps: ServerDeps, orders: readonly OrderRecord[]): Promise<Map<string, Market>> {
  const index = new Map<string, Market>()
  for (const id of new Set(orders.map((order) => order.marketId))) {
    const market = await getMarket(deps.sql, id)
    if (market) index.set(id, market)
  }
  return index
}

function limitParam(ctx: RequestContext, fallback: number, max: number): number {
  const raw = ctx.url.searchParams.get('limit')
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestError(`limit must be a whole number between 1 and ${max}`)
  }
  return value
}

/** An amount that may legitimately be absent. Absent and zero are different and stay different. */
function optionalAmount(body: Record<string, unknown>, field: string): bigint | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  return requireAmount(body, field)
}

/**
 * A good-till-date expiry, as epoch milliseconds or an ISO-8601 instant.
 *
 * Refused when it is already in the past. The engine would accept it — the order would rest and the
 * maintenance job would expire it within seconds — but silently accepting an order that is dead on
 * arrival is worse than refusing it, because the customer's screen shows an order for those seconds.
 */
function readExpiry(body: Record<string, unknown>, clock: Clock): number | null {
  const value = body['expiresAt']
  if (value === undefined || value === null) return null
  const at =
    typeof value === 'number'
      ? Number.isSafeInteger(value)
        ? value
        : Number.NaN
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN
  if (!Number.isFinite(at)) {
    throw new BadRequestError('expiresAt must be epoch milliseconds or an ISO-8601 timestamp')
  }
  if (at <= clock.now()) throw new BadRequestError('expiresAt is already in the past')
  return at
}

/** Everything a placement needs, parsed but not judged: the rules are `validatePlacement`'s. */
function placementFrom(
  userId: string,
  market: Market,
  body: Record<string, unknown>,
  clock: Clock,
): PlaceOrderInput {
  const side = body['side']
  if (!isSide(side)) throw new BadRequestError("side must be 'buy' or 'sell'")
  const type = body['type']
  if (!isPlacedOrderType(type)) {
    throw new BadRequestError(`type must be one of ${PLACED_ORDER_TYPES.join(', ')}`)
  }
  const tif = body['tif'] ?? 'gtc'
  if (!isTimeInForce(tif)) throw new BadRequestError(`tif must be one of ${TIME_IN_FORCE.join(', ')}`)
  const stp = body['stp'] ?? 'cancel_taker'
  if (!isStpMode(stp)) throw new BadRequestError(`stp must be one of ${STP_MODES.join(', ')}`)
  const postOnly = body['postOnly'] ?? false
  if (typeof postOnly !== 'boolean') throw new BadRequestError('postOnly must be true or false')
  const rawClientId = body['clientOrderId']
  return {
    userId,
    marketId: market.id,
    side,
    type,
    price: optionalAmount(body, 'price'),
    stopPrice: optionalAmount(body, 'stopPrice'),
    qty: optionalAmount(body, 'qty'),
    quoteQty: optionalAmount(body, 'quoteQty'),
    tif,
    postOnly,
    stp,
    displayQty: optionalAmount(body, 'displayQty'),
    clientOrderId:
      rawClientId === undefined || rawClientId === null ? null : requireString(body, 'clientOrderId', 64),
    expiresAtMs: readExpiry(body, clock),
  }
}

/**
 * What makes two placements "the same request".
 *
 * Every field of the order, spelled as strings. A key reused with so much as a different quantity is
 * a 409 rather than a replay — because the alternative is answering a customer's second, different
 * order with the receipt for their first one.
 */
function placementFingerprint(input: PlaceOrderInput): Record<string, unknown> {
  return {
    userId: input.userId,
    marketId: input.marketId,
    side: input.side,
    type: input.type,
    price: nullableAmount(input.price),
    stopPrice: nullableAmount(input.stopPrice),
    qty: nullableAmount(input.qty),
    quoteQty: nullableAmount(input.quoteQty),
    tif: input.tif,
    postOnly: input.postOnly,
    stp: input.stp,
    displayQty: nullableAmount(input.displayQty),
    clientOrderId: input.clientOrderId,
    expiresAtMs: input.expiresAtMs,
  }
}

/* --------------------------------------------------------------- exchange views */

/** A bigint or a null, never a number. See the note on `backtestView` for why every view exists. */
const nullableAmount = (value: bigint | null): string | null => (value === null ? null : amountTo(value))

function marketView(market: Market): Record<string, unknown> {
  const band = priceBand(market)
  return {
    id: market.id,
    symbol: market.symbol,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    lotSize: amountTo(market.lotSize),
    tickSize: amountTo(market.tickSize),
    minNotional: amountTo(market.minNotional),
    makerFeeBps: market.makerFeeBps,
    takerFeeBps: market.takerFeeBps,
    status: market.status,
    bandBps: market.bandBps,
    referencePrice: nullableAmount(market.referencePrice),
    lastPrice: nullableAmount(market.lastPrice),
    lastTradedAt: market.lastTradedAt,
    // Served rather than left for the client to compute, so the browser's fat-finger warning and the
    // service's refusal are the same arithmetic. `null` means the market has never traded and there
    // is nothing to measure a price against yet.
    band: band === null ? null : { low: amountTo(band.low), high: amountTo(band.high) },
  }
}

/**
 * An order, with the average price it actually traded at.
 *
 * `market` is nullable because a cancelled order outlives nothing but its own market row is still
 * the only place the base unit lives; where it is absent the average is omitted rather than guessed.
 */
function orderView(market: Market | null, order: OrderRecord): Record<string, unknown> {
  return {
    id: order.id,
    marketId: order.marketId,
    symbol: market?.symbol ?? null,
    // A string: `sequence` is a bigserial and the book's whole ordering rests on it, so it must not
    // be rounded by a JSON number on the way out.
    sequence: order.sequence.toString(),
    clientOrderId: order.clientOrderId,
    side: order.side,
    type: order.type,
    price: nullableAmount(order.price),
    stopPrice: nullableAmount(order.stopPrice),
    tif: order.tif,
    postOnly: order.postOnly,
    stp: order.stp,
    qty: nullableAmount(order.qty),
    quoteQty: nullableAmount(order.quoteQty),
    displayQty: nullableAmount(order.displayQty),
    remaining: amountTo(order.remaining),
    filledQty: amountTo(order.filledQty),
    filledQuoteQty: amountTo(order.filledQuoteQty),
    averagePrice: market === null ? null : nullableAmount(averagePrice(order, baseUnitOf(market))),
    feeBase: amountTo(order.feeBase),
    feeQuote: amountTo(order.feeQuote),
    heldAsset: order.heldAsset,
    heldAmount: amountTo(order.heldAmount),
    status: order.status,
    cancelReason: order.cancelReason,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  }
}

function orderEventView(event: OrderEventRecord): Record<string, unknown> {
  return {
    seq: event.seq.toString(),
    kind: event.kind,
    qty: amountTo(event.qty),
    price: nullableAmount(event.price),
    detail: event.detail,
    at: event.createdAt,
  }
}

function depthView(depth: DepthSnapshot): Record<string, unknown> {
  const level = (row: DepthSnapshot['bids'][number]): Record<string, unknown> => ({
    price: amountTo(row.price),
    qty: amountTo(row.qty),
    orders: row.orders,
  })
  return { bids: depth.bids.map(level), asks: depth.asks.map(level) }
}

function tickerView(day: Ticker): Record<string, unknown> {
  return {
    marketId: day.marketId,
    last: nullableAmount(day.last),
    open: nullableAmount(day.open),
    high: nullableAmount(day.high),
    low: nullableAmount(day.low),
    baseVolume: amountTo(day.baseVolume),
    quoteVolume: amountTo(day.quoteVolume),
    trades: day.trades,
    changeBps: day.changeBps,
  }
}

function publicTradeView(trade: PublicTrade): Record<string, unknown> {
  return {
    id: trade.id,
    seq: trade.seq.toString(),
    price: amountTo(trade.price),
    qty: amountTo(trade.qty),
    quoteQty: amountTo(trade.quoteQty),
    takerSide: trade.takerSide,
    at: trade.at,
  }
}

function candleView(candle: Candle): Record<string, unknown> {
  return {
    t: candle.t,
    open: amountTo(candle.open),
    high: amountTo(candle.high),
    low: amountTo(candle.low),
    close: amountTo(candle.close),
    baseVolume: amountTo(candle.baseVolume),
    quoteVolume: amountTo(candle.quoteVolume),
    trades: candle.trades,
  }
}

function fillView(fill: OwnFill): Record<string, unknown> {
  return {
    tradeId: fill.tradeId,
    orderId: fill.orderId,
    marketId: fill.marketId,
    side: fill.side,
    role: fill.role,
    price: amountTo(fill.price),
    qty: amountTo(fill.qty),
    quoteQty: amountTo(fill.quoteQty),
    fee: amountTo(fill.fee),
    feeAsset: fill.feeAsset,
    at: fill.at,
  }
}

function balanceView(balance: Balance): Record<string, unknown> {
  return {
    asset: balance.asset,
    available: amountTo(balance.available),
    held: amountTo(balance.held),
    // Derived here rather than left to the client, because every client wants it and each of them
    // would otherwise add two decimal strings as numbers to get it.
    total: amountTo(balance.available + balance.held),
  }
}

function transferView(transfer: TransferRecord): Record<string, unknown> {
  return {
    id: transfer.id,
    asset: transfer.asset,
    direction: transfer.direction,
    amount: amountTo(transfer.amount),
    status: transfer.status,
    entryId: transfer.entryId,
    error: transfer.error,
    createdAt: transfer.createdAt,
    settledAt: transfer.settledAt,
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The current mark for a bot's position, and what it was taken against — or null.
 *
 * Null rather than a throw, because the one caller — `stopBot` — has a defined narrower behaviour
 * for "no price" and turning it into an exception would abort a stop that must complete.
 *
 * The quote's own `source` is returned with the number rather than being re-derived from the asset
 * later. This path always asks pricing, so `bar` cannot arise here — a stop re-marks a paper bot
 * against the oracle too, which is the same price its final assessment is computed from.
 */
async function markEquityAt(deps: ServerDeps, bot: BotRecord): Promise<Mark | null> {
  const series = await getSeries(deps.sql, bot.seriesId)
  if (!series) return null
  try {
    const { equityOf } = await import('./money.ts')
    const quote = await deps.pricing.quote(series.assetCode as never)
    return {
      equity: equityOf(bot.cash, bot.position, series.assetCode as never, quote.midScaled),
      priceSource: quote.source,
    }
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

/** Amounts leave as decimal strings. A cent balance fits in a double; a position in wei does not. */
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
    if (!/^\d+$/.test(value)) throw new BadRequestError(`${field} must be a whole number of US cents, as a string`)
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
