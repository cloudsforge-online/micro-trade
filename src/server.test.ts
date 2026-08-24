/**
 * The HTTP surface, over a real socket against a real Postgres.
 *
 * Two things are under test here that are not under test anywhere else: **the auth-fault mapping**
 * (a bad token is 401, an unreachable verifier is 503, and confusing them signs the estate out), and
 * **idempotency on every mutating route** — which is not a nice-to-have here, because `start`
 * reserves capital and a retried start without a key would be a second reservation.
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics } from './server.ts'
import { signEvent } from './outbox.ts'
import { runBacktest } from './backtests.ts'
import { LIVE_DISABLED, updateBot } from './bots.ts'
import { RATE_SCALE } from './money.ts'
import {
  ALICE,
  BOB,
  EVENT_SECRET,
  enabled,
  fakeLedger,
  fakePricing,
  freshKey,
  makeBars,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTrade,
  seedBalance,
  seedMarket,
  seedSeries,
  skip,
  testClock,
  verifier,
  type FakeLedger,
  type FakePricing,
  type TestClock,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let db: Db
let server: Server
let baseUrl: string
let ledger: FakeLedger
let pricing: FakePricing
let clock: TestClock
let enqueued: Array<{ kind: string; key: string }>
let seriesId: string

/**
 * The inbound accept list, read through a getter below so a test can restage a rotation without
 * rebuilding the server. `beforeEach` puts it back to the single-secret default.
 */
let acceptSecrets: readonly string[] = [EVENT_SECRET]

/** The secret a rotation moves TO. Obviously fake, and long enough to clear the 24-char rule. */
const ROTATED_SECRET = 'a-rotated-looking-secret-of-sufficient-length'

const BAR_WIDTH = 3_600
const BARS = makeBars({ count: 200, shape: 'sawtooth', widthSeconds: BAR_WIDTH })
const NEWEST = BARS[BARS.length - 1] as (typeof BARS)[number]
const FRESH_MS = (NEWEST.t + BAR_WIDTH + 1) * 1000

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
  ledger = fakeLedger()
  pricing = fakePricing()
  clock = testClock(FRESH_MS)
  enqueued = []

  server = createServer({
    lifecycle,
    // Discarded unless DEBUG_TRADE is set, which is how the 500 behind a failing assertion is read.
    logger: process.env['DEBUG_TRADE']
      ? new Logger({ service: 'trade-test', level: 'debug' })
      : new Logger({ service: 'trade-test', level: 'fatal', sink: () => {} }),
    metrics,
    verifier,
    sql: singleNetworkSql(db),
    singleNetwork: 'mainnet' as const,
    producer: 'trade',
    queue: {
      async enqueue(options: { kind: string; key: string }) {
        enqueued.push({ kind: options.kind, key: options.key })
      },
    },
    // One queue, presented as the per-network selector. The fixture runs against a single database,
    // so both estates resolve to it — what is under test is that a route ASKS for a network.
    queueFor: () => ({
      async enqueue(options: { kind: string; key: string }) {
        enqueued.push({ kind: options.kind, key: options.key })
      },
    }),
    // Read through getters so `beforeEach` can replace the fakes without rebuilding the server.
    get ledger() {
      return ledger
    },
    get pricing() {
      return pricing
    },
    get clock() {
      return clock
    },
    liveEnabled: true,
    exchangeEnabled: true,
    settlementPeriodSeconds: 3_600,
    get eventAcceptSecrets() {
      return acceptSecrets
    },
  } as never)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lifecycle.markReady()
})

beforeEach(async () => {
  if (!enabled) return
  await resetTrade(sql)
  ledger = fakeLedger()
  ledger.setBalance(ALICE, 100_000_000n)
  pricing = fakePricing()
  pricing.set('BTC', 30_000n * RATE_SCALE)
  clock = testClock(FRESH_MS)
  enqueued = []
  acceptSecrets = [EVENT_SECRET]
  seriesId = await seedSeries(db, BARS)
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

interface CallOptions {
  method?: string
  token?: string
  body?: unknown
  headers?: Record<string, string>
  key?: string | null
}

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.key === null ? {} : { 'idempotency-key': options.key ?? freshKey() }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  // `/metrics` answers Prometheus text, not JSON, so the helper must not assume a body it can parse.
  const isJson = (response.headers.get('content-type') ?? '').includes('json')
  return {
    status: response.status,
    body: text.length > 0 && isJson ? JSON.parse(text) : text,
    headers: response.headers,
  }
}

const botBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'my bot',
  mode: 'paper',
  seriesId,
  strategyId: 'sma_cross',
  params: { fast: 5, slow: 20 },
  allocation: '1000000',
  ...overrides,
})

async function createBot(overrides: Record<string, unknown> = {}, token = 'alice'): Promise<string> {
  const response = await call('/v1/bots', { method: 'POST', token, body: botBody(overrides) })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body.botId as string
}

/* ------------------------------------------------------------------ health */

test('livez is static, so a database blip does not restart a healthy process', { skip }, async () => {
  const response = await call('/livez')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
})

test('readyz reports the probe set, and metrics render in Prometheus text', { skip }, async () => {
  const ready = await call('/readyz')
  assert.ok(ready.status === 200 || ready.status === 503)
  assert.ok(Array.isArray(ready.body.checks))

  const metrics = await call('/metrics')
  assert.equal(metrics.status, 200)
  assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/)
  assert.match(String(metrics.body), /http_requests_total/)
})

test('every response carries the request id in the body and the header', { skip }, async () => {
  const response = await call('/v1/bots', { token: 'nope' })
  assert.equal(response.status, 401)
  assert.equal(response.body.error.requestId, response.headers.get('x-request-id'))
})

test('an inbound request id is echoed only when it is safe to log', { skip }, async () => {
  const safe = await call('/livez', { headers: { 'x-request-id': 'abc-123_XYZ' } })
  assert.equal(safe.headers.get('x-request-id'), 'abc-123_XYZ')
  const unsafe = await call('/livez', { headers: { 'x-request-id': 'a b<script>' } })
  assert.notEqual(unsafe.headers.get('x-request-id'), 'a b<script>')
})

test('an unmatched path is a 404 with the standard error shape', { skip }, async () => {
  const response = await call('/v1/nothing')
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'not_found')
})

/* ------------------------------------------------------------------ auth */

test('a bad token is 401 and never says which half of it was wrong', { skip }, async () => {
  const response = await call('/v1/bots', { token: 'forged' })
  assert.equal(response.status, 401)
  assert.equal(response.body.error.message, 'a valid bearer token is required')
})

test('a missing token takes the same 401 path as a bad one', { skip }, async () => {
  assert.equal((await call('/v1/bots')).status, 401)
})

test('an unreachable verifier is 503, not 401, or one identity blip signs the estate out', { skip }, async () => {
  const response = await call('/v1/bots', { token: 'down' })
  assert.equal(response.status, 503)
  assert.equal(response.body.error.code, 'verifier_unavailable')
})

test('a service token without the scope is 403 and names what it lacked', { skip }, async () => {
  const response = await call('/v1/bots', { token: 'svc-none' })
  assert.equal(response.status, 403)
  assert.match(response.body.error.message, /trade:read/)
})

test('a user cannot read another user bot', { skip }, async () => {
  const botId = await createBot()
  const response = await call(`/v1/bots/${botId}`, { token: 'bob' })
  assert.equal(response.status, 404, 'a bot belonging to someone else must not be readable')
})

test('an admin may read another user bot, because operators exist', { skip }, async () => {
  const botId = await createBot()
  const response = await call(`/v1/bots/${botId}?userId=${ALICE}`, { token: 'admin' })
  assert.equal(response.status, 200)
})

test('the strategy catalogue is public, because it is a product surface', { skip }, async () => {
  const response = await call('/v1/strategies')
  assert.equal(response.status, 200)
  assert.equal(response.body.strategies.length, 10)
  assert.ok(response.body.strategies.every((s: { weakness: string }) => s.weakness.length > 0))
})

test('only an operator may register a series or ingest bars', { skip }, async () => {
  const asUser = await call('/v1/series', {
    method: 'POST',
    token: 'alice',
    body: { symbol: 'ETH-USD', assetCode: 'ETH', timeframe: '1h', source: 'x' },
  })
  assert.equal(asUser.status, 403)

  const asOperator = await call('/v1/series', {
    method: 'POST',
    token: 'admin',
    body: { symbol: 'ETH-USD', assetCode: 'ETH', timeframe: '1h', source: 'x' },
  })
  assert.equal(asOperator.status, 201)
})

/* ------------------------------------------------------------------ idempotency */

test('a mutating request without an idempotency key is refused', { skip }, async () => {
  const response = await call('/v1/bots', { method: 'POST', token: 'alice', body: botBody(), key: null })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /idempotency-key/)
})

test('the same key with the same body replays rather than creating a second bot', { skip }, async () => {
  const key = freshKey()
  const first = await call('/v1/bots', { method: 'POST', token: 'alice', body: botBody(), key })
  const second = await call('/v1/bots', { method: 'POST', token: 'alice', body: botBody(), key })
  assert.equal(first.status, 201)
  assert.equal(second.status, 200, 'a replay must be distinguishable from a fresh create')
  assert.equal(first.body.botId, second.body.botId)

  const list = await call('/v1/bots', { token: 'alice' })
  assert.equal(list.body.bots.length, 1)
})

test('the same key with a different body is refused rather than replayed', { skip }, async () => {
  // Returning the first request's answer to a second, different request is worse than an error: the
  // caller believes the thing it asked for happened.
  const key = freshKey()
  await call('/v1/bots', { method: 'POST', token: 'alice', body: botBody(), key })
  const second = await call('/v1/bots', {
    method: 'POST',
    token: 'alice',
    body: botBody({ allocation: '9999999' }),
    key,
  })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'idempotency_key_reuse')
})

test('a retried start reserves capital once, not twice', { skip }, async () => {
  const botId = await createBot({ mode: 'live' })
  const key = freshKey()
  await call(`/v1/bots/${botId}/actions`, { method: 'POST', token: 'alice', body: { action: 'start' }, key })
  await call(`/v1/bots/${botId}/actions`, { method: 'POST', token: 'alice', body: { action: 'start' }, key })
  assert.equal(ledger.keys.filter((k) => k.startsWith('trade:allocation:')).length, 1)
})

/* ------------------------------------------------------------------ bots */

test('a bot is created, listed and read back with its amounts as decimal strings', { skip }, async () => {
  const botId = await createBot()
  const response = await call(`/v1/bots/${botId}`, { token: 'alice' })
  assert.equal(response.status, 200)
  assert.equal(typeof response.body.bot.allocation, 'string')
  assert.equal(response.body.bot.allocation, '1000000')
  assert.equal(response.body.bot.status, 'draft')
})

test('a bot carries the provenance of its mark to the client, not just the number', { skip }, async () => {
  // micro-org#368: trade-web renders this, and it can only render what the API sends. Asserted on
  // the field's PRESENCE at null as well as on its value, because `botView` spreads the record and a
  // field silently dropped from `COLUMNS` would come back `undefined` — which JSON omits, and which
  // a frontend reading "no source" and "not marked yet" the same way would never notice.
  const botId = await createBot()
  const fresh = await call(`/v1/bots/${botId}`, { token: 'alice' })
  assert.equal(fresh.status, 200)
  assert.ok(Object.hasOwn(fresh.body.bot as object, 'equityPriceSource'), 'the mark reaches the client unattributed')
  assert.equal(fresh.body.bot.equityPriceSource, null, 'an unmarked bot claimed a price source')

  await updateBot(db, botId, { equity: 1_100_000n, equityPriceSource: 'administered' })
  const marked = await call(`/v1/bots/${botId}`, { token: 'alice' })
  assert.equal(marked.body.bot.equityPriceSource, 'administered')
})

test('an allocation sent as an unsafe JSON number is refused rather than silently truncated', { skip }, async () => {
  const response = await call('/v1/bots', {
    method: 'POST',
    token: 'alice',
    body: botBody({ allocation: Number.MAX_SAFE_INTEGER + 2 }),
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /decimal string/)
})

test('an unknown strategy or series is a 404, not a 500', { skip }, async () => {
  assert.equal((await call('/v1/bots', { method: 'POST', token: 'alice', body: botBody({ strategyId: 'nope' }) })).status, 404)
  assert.equal(
    (
      await call('/v1/bots', {
        method: 'POST',
        token: 'alice',
        body: botBody({ seriesId: '00000000-0000-4000-8000-000000000000' }),
      })
    ).status,
    404,
  )
})

test('a bot moves through start, pause and stop', { skip }, async () => {
  const botId = await createBot()
  const started = await call(`/v1/bots/${botId}/actions`, { method: 'POST', token: 'alice', body: { action: 'start' } })
  assert.equal(started.status, 200)
  assert.equal(started.body.status, 'running')

  const paused = await call(`/v1/bots/${botId}/actions`, { method: 'POST', token: 'alice', body: { action: 'pause' } })
  assert.equal(paused.body.status, 'paused')

  const stopped = await call(`/v1/bots/${botId}/actions`, { method: 'POST', token: 'alice', body: { action: 'stop' } })
  assert.equal(stopped.body.status, 'stopped')
})

test('an unknown action is a 400 rather than a silent no-op', { skip }, async () => {
  const botId = await createBot()
  const response = await call(`/v1/bots/${botId}/actions`, {
    method: 'POST',
    token: 'alice',
    body: { action: 'explode' },
  })
  assert.equal(response.status, 400)
})

test('pausing a bot that is not running is a 409 that says so', { skip }, async () => {
  const botId = await createBot()
  const response = await call(`/v1/bots/${botId}/actions`, { method: 'POST', token: 'alice', body: { action: 'pause' } })
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'bot_state')
})

test('a bot fills and settlements list is scoped to its owner', { skip }, async () => {
  const botId = await createBot()
  assert.equal((await call(`/v1/bots/${botId}/fills`, { token: 'alice' })).status, 200)
  assert.equal((await call(`/v1/bots/${botId}/settlements`, { token: 'alice' })).status, 200)
  assert.equal((await call(`/v1/bots/${botId}/fills`, { token: 'bob' })).status, 404)
})

/* ------------------------------------------------------------------ backtests */

test('a backtest answers 202 with a status url rather than running inside the request', { skip }, async () => {
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, startCash: '1000000', seed: 3 },
  })
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('location'), `/v1/backtests/${response.body.backtestId}`)
  assert.deepEqual(enqueued, [{ kind: 'backtest.run', key: `backtest:${response.body.backtestId}` }])

  const queued = await call(response.body.statusUrl, { token: 'alice' })
  assert.equal(queued.status, 200, JSON.stringify(queued.body))
  assert.equal(queued.body.backtest.status, 'queued')
})

test('a queued backtest runs to a stored result with a digest', { skip }, async () => {
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, startCash: '1000000', seed: 3 },
  })
  const id = response.body.backtestId as string
  assert.equal(await runBacktest({ sql: db, logger: quietLogger() }, id), 'complete')

  const done = await call(`/v1/backtests/${id}`, { token: 'alice' })
  assert.equal(done.body.backtest.status, 'complete')
  assert.equal(typeof done.body.backtest.resultDigest, 'string')
  assert.equal(typeof done.body.backtest.metrics.endEquity, 'string')
})

/**
 * The equity curve and the fill list were computed, stored, and served by nothing.
 *
 * `runBacktest` wrote `trades` and `equity`; `COLUMNS` in backtests.ts selected neither, so no read
 * path could reach them. A client could report how deep a drawdown was and never when it happened.
 * These four tests are the ones that would have caught it.
 */
test('a completed backtest serves the equity curve and the fills it stored', { skip }, async () => {
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, startCash: '1000000', seed: 3 },
  })
  const id = response.body.backtestId as string
  assert.equal(await runBacktest({ sql: db, logger: quietLogger() }, id), 'complete')

  const result = await call(`/v1/backtests/${id}/result`, { token: 'alice' })
  assert.equal(result.status, 200)
  assert.ok(Array.isArray(result.body.equity), 'the equity curve must be served, not merely stored')
  assert.ok(result.body.equity.length > 0, 'a completed run over a real series has a curve')
  assert.ok(Array.isArray(result.body.fills), 'the fill list must be served')
})

test('an unfinished backtest is a state, not an empty result', { skip }, async () => {
  // An empty fill list is a real answer — a strategy that never traded — so it must not be the
  // same answer as "it has not run yet". This is the distinction 200-with-empty-arrays destroys.
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, startCash: '1000000', seed: 4 },
  })
  const pending = await call(`/v1/backtests/${response.body.backtestId}/result`, { token: 'alice' })
  assert.equal(pending.status, 409)
  assert.equal(pending.body.error.code, 'backtest_not_complete')
  assert.match(pending.body.error.message, /queued/)
})

test("a result is scoped to its owner, in the query rather than after it", { skip }, async () => {
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, startCash: '1000000', seed: 5 },
  })
  await runBacktest({ sql: db, logger: quietLogger() }, response.body.backtestId)
  const asBob = await call(`/v1/backtests/${response.body.backtestId}/result`, { token: 'bob' })
  assert.equal(asBob.status, 404, "another user's backtest is absent, not forbidden")
})

test('the deployment reports whether live trading is switched on, without a token', { skip }, async () => {
  // TRADE_LIVE_ENABLED defaults to false and nothing reported it, so a customer could configure a
  // live bot and learn only when it refused to tick. Public, because it is a property of the
  // deployment rather than of the caller.
  const capabilities = await call('/v1/capabilities')
  assert.equal(capabilities.status, 200)
  assert.equal(typeof capabilities.body.capabilities.liveTrading.enabled, 'boolean')
  if (!capabilities.body.capabilities.liveTrading.enabled) {
    // The engine's own sentence, not a paraphrase that can drift from it.
    assert.equal(capabilities.body.capabilities.liveTrading.refusal, LIVE_DISABLED)
  }
})

test('two runs of one queued configuration agree, because the seed is stored with it', { skip }, async () => {
  const body = { seriesId, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, startCash: '1000000', seed: 11 }
  const a = await call('/v1/backtests', { method: 'POST', token: 'alice', body })
  const b = await call('/v1/backtests', { method: 'POST', token: 'alice', body })
  await runBacktest({ sql: db, logger: quietLogger() }, a.body.backtestId)
  await runBacktest({ sql: db, logger: quietLogger() }, b.body.backtestId)

  const first = await call(`/v1/backtests/${a.body.backtestId}`, { token: 'alice' })
  const second = await call(`/v1/backtests/${b.body.backtestId}`, { token: 'alice' })
  assert.equal(first.body.backtest.resultDigest, second.body.backtest.resultDigest)
})

test('a run over too short a series fails with a reason rather than a meaningless result', { skip }, async () => {
  const shortId = await seedSeries(db, makeBars({ count: 5 }), { symbol: 'SOL-USD', assetCode: 'SOL' })
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId: shortId, strategyId: 'buy_hold', startCash: '1000', seed: 0 },
  })
  assert.equal(await runBacktest({ sql: db, logger: quietLogger() }, response.body.backtestId), 'failed')
  const done = await call(`/v1/backtests/${response.body.backtestId}`, { token: 'alice' })
  assert.equal(done.body.backtest.status, 'failed')
  assert.match(done.body.backtest.error, /not enough to draw a conclusion/)
})

test('a clamped parameter is reported on the run rather than silently applied', { skip }, async () => {
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'sma_cross', params: { fast: 9_999 }, startCash: '1000000' },
  })
  assert.ok((response.body.notes as string[]).some((note) => note.includes('clamped')))
})

test('an out-of-range seed is refused, so a run cannot be unreproducible by accident', { skip }, async () => {
  const response = await call('/v1/backtests', {
    method: 'POST',
    token: 'alice',
    body: { seriesId, strategyId: 'buy_hold', startCash: '1000', seed: -1 },
  })
  assert.equal(response.status, 400)
})

/* ------------------------------------------------------------------ series ingest */

test('bars are ingested as scaled integer strings, and a replay accepts none twice', { skip }, async () => {
  const fresh = await call('/v1/series', {
    method: 'POST',
    token: 'admin',
    body: { symbol: 'XRP-USD', assetCode: 'XRP', timeframe: '1h', source: 'fixture' },
  })
  const id = fresh.body.series.id as string
  const bars = makeBars({ count: 3, widthSeconds: BAR_WIDTH }).map((bar) => ({
    t: bar.t,
    o: bar.o.toString(),
    h: bar.h.toString(),
    l: bar.l.toString(),
    c: bar.c.toString(),
  }))

  const key = freshKey()
  const first = await call(`/v1/series/${id}/bars`, { method: 'POST', token: 'admin', body: { bars }, key })
  assert.equal(first.status, 201)
  assert.equal(first.body.accepted, 3)

  const replay = await call(`/v1/series/${id}/bars`, { method: 'POST', token: 'admin', body: { bars }, key })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.accepted, 3, 'a replay must report what the original did')
})

test('a price sent as a JSON number is refused, because a double has already lost it', { skip }, async () => {
  const response = await call(`/v1/series/${seriesId}/bars`, {
    method: 'POST',
    token: 'admin',
    body: { bars: [{ t: NEWEST.t - BAR_WIDTH, o: 1, h: 1, l: 1, c: 1 }] },
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /scaled integer as a decimal string/)
})

test('an unclosed bar is refused at ingest, not stored and quietly traded on', { skip }, async () => {
  const open = NEWEST.t + BAR_WIDTH
  const response = await call(`/v1/series/${seriesId}/bars`, {
    method: 'POST',
    token: 'admin',
    body: { bars: [{ t: open, o: '1000000', h: '1000000', l: '1000000', c: '1000000' }] },
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /has not closed/)
})

/* ------------------------------------------------------------------ the events webhook */

async function postEvent(envelope: Record<string, unknown>, signature?: string): Promise<{ status: number; body: any }> {
  const body = JSON.stringify(envelope)
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-signature': signature ?? signEvent(body, EVENT_SECRET),
    },
    body,
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} }
}

const deletedEnvelope = (id = '33333333-3333-4333-8333-333333333333', userId = ALICE) => ({
  id,
  topic: 'identity.user.deleted',
  key: userId,
  occurredAt: '2026-01-01T00:00:00.000Z',
  producer: 'identity',
  version: '1.0',
  payload: { userId },
})

test('an event with no valid signature is refused before its body is parsed', { skip }, async () => {
  const response = await postEvent(deletedEnvelope(), 'sha256=deadbeef')
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'bad_signature')
})

/**
 * **THE PROPERTY A ROLLING ROTATION DEPENDS ON.**
 *
 * `OUTBOX_SIGNING_SECRET` is one key shared across the estate. Rotating it means producers and
 * receivers change over a window, and during that window some producers are still signing with the
 * old key. If this route accepted only the new one their deliveries would 403 — and the topic this
 * route consumes is `identity.user.deleted`, so a silent partition is an erasure obligation quietly
 * not met, on a service that stores `user_id`.
 *
 * So: the NEW secret leads the accept list, the delivery is signed with the SUPERSEDED one, and it
 * must still be acted on.
 */
test('AN EVENT SIGNED WITH THE SUPERSEDED SECRET IS STILL ACCEPTED WHILE THE NEW ONE LEADS', { skip }, async () => {
  const botId = await createBot()
  acceptSecrets = [ROTATED_SECRET, EVENT_SECRET]
  const body = JSON.stringify(deletedEnvelope())
  // Signed with the OLD key — what a producer that has not been redeployed yet sends.
  const response = await postEvent(deletedEnvelope(), signEvent(body, EVENT_SECRET))
  assert.equal(response.status, 202, 'a producer still on the superseded secret must not be partitioned off')
  assert.equal(response.body.status, 'recorded')
  const rows = await sql<{ id: string }[]>`select id from bots where id = ${botId}`
  assert.equal(rows.length, 0, 'the erasure must actually have run, not merely been acknowledged')
})

test('A SECRET THAT IS NOT ON THE ACCEPT LIST IS STILL REFUSED', { skip }, async () => {
  // The other direction. Accepting a list must not become accepting anything: dropping the old
  // secret from the list is what finishes a rotation, and it has to actually stop those deliveries.
  acceptSecrets = [ROTATED_SECRET]
  const body = JSON.stringify(deletedEnvelope())
  const response = await postEvent(deletedEnvelope(), signEvent(body, EVENT_SECRET))
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'bad_signature')
})

test('an event for a topic this service does not subscribe to is acknowledged and ignored', { skip }, async () => {
  // Never a 4xx: that would make the producer retry the same event for ever.
  const response = await postEvent({ ...deletedEnvelope(), topic: 'billing.invoice.paid' })
  assert.equal(response.status, 202)
  assert.equal(response.body.status, 'ignored')
})

test('a deleted user has their bots erased, and a redelivery is a no-op', { skip }, async () => {
  const botId = await createBot()
  const bobBot = await createBot({}, 'bob')

  const first = await postEvent(deletedEnvelope())
  assert.equal(first.status, 202)
  assert.equal(first.body.status, 'recorded')

  const second = await postEvent(deletedEnvelope())
  assert.equal(second.body.status, 'duplicate', 'a redelivery must not re-run the handler')

  const rows = await sql<{ id: string }[]>`select id from bots`
  assert.deepEqual(rows.map((row) => row.id), [bobBot])
  void botId
})

test('an erasure event with no user id is a 400 rather than deleting nothing quietly', { skip }, async () => {
  const response = await postEvent({ ...deletedEnvelope(), payload: {} })
  assert.equal(response.status, 400)
})

/* ------------------------------------------------------------------ bodies */

test('a malformed body is a 400 with the standard shape', { skip }, async () => {
  const response = await fetch(`${baseUrl}/v1/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer alice', 'idempotency-key': freshKey() },
    body: '{ not json',
  })
  assert.equal(response.status, 400)
})

test('an oversized body is refused part-way through, and the connection is not reused', { skip }, async () => {
  // Two outcomes are both correct here, and which one a client sees depends on how much of its body
  // was already in flight: a 400, or a closed connection while it was still writing. Refusing EARLY
  // is the property that matters — an unbounded body is a memory-exhaustion primitive any
  // unauthenticated caller can reach — and having refused without reading the remainder, the socket
  // cannot be reused: the unread tail would be parsed as the start of the next request.
  //
  // Asserting only the 400 would be asserting the friendlier of the two, and would fail on the
  // safer one.
  let refused = false
  try {
    const response = await fetch(`${baseUrl}/v1/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer alice', 'idempotency-key': freshKey() },
      body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }),
    })
    refused = response.status === 400
  } catch {
    // The server closed the socket mid-upload. That IS the refusal.
    refused = true
  }
  assert.ok(refused, 'an oversized body was accepted')

  // The next request must be unaffected — which is what the connection header buys.
  assert.equal((await call('/livez')).status, 200)
})

test('an id that is not a uuid is a 400 rather than a database error', { skip }, async () => {
  assert.equal((await call('/v1/bots/not-a-uuid', { token: 'alice' })).status, 400)
})

/* ------------------------------------------------------------------ the exchange */

/**
 * The order book over HTTP.
 *
 * `src/exchange.test.ts` proves the engine and `src/matching.test.ts` proves the ranking. What is
 * left for this file is everything between the socket and those: who is allowed to ask, what a
 * refusal looks like on the wire, that a retried placement is a replay and not a second order, and
 * that money leaves the process as a decimal string and never as a JSON number.
 */

const LOT = 100_000n
const TICK = 1_000_000_000_000n
const TEN_LOTS = LOT * 10n
const PRICE = TICK * 2n
/** `qty * price / 10^8` for the seeded market's decimals. Exact by the notional CHECK. */
const NOTIONAL = (TEN_LOTS * PRICE) / 100_000_000n

async function seedExchange(): Promise<{ id: string; symbol: string }> {
  const id = await seedMarket(db)
  const rows = await sql<{ symbol: string }[]>`select symbol from markets where id = ${id}`
  await seedBalance(db, ALICE, 'EMBER', 1_000_000_000_000n)
  await seedBalance(db, ALICE, 'BTC', TEN_LOTS * 10n)
  await seedBalance(db, BOB, 'EMBER', 1_000_000_000_000n)
  await seedBalance(db, BOB, 'BTC', TEN_LOTS * 10n)
  return { id, symbol: rows[0]?.symbol as string }
}

const orderBody = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol,
  side: 'buy',
  type: 'limit',
  price: PRICE.toString(),
  qty: TEN_LOTS.toString(),
  ...over,
})

test('capabilities names every order type and time-in-force the book accepts', { skip }, async () => {
  const response = await call('/v1/capabilities')
  assert.equal(response.status, 200)
  const book = response.body.capabilities.orderBook
  assert.equal(book.enabled, true)
  // The browser builds its order ticket from this rather than from a second hardcoded list, so a
  // type added to the engine and not to this response is a type no customer can reach.
  assert.deepEqual(book.orderTypes, ['limit', 'market', 'stop_limit', 'stop_market'])
  assert.ok(book.timeInForce.includes('gtd'))
  assert.ok(book.stpModes.includes('cancel_taker'))
  assert.ok(book.candleIntervals.includes('1m'))
})

test('the exchange tape is public in content but not in access', { skip }, async () => {
  const { symbol } = await seedExchange()
  // Anonymous is 401, not 200. There is no rate-limit subject for a caller with no principal, and
  // the depth and candle routes are the cheapest thing in the world to put in a loop.
  assert.equal((await call(`/v1/exchange/markets/${symbol}/depth`)).status, 401)
  assert.equal((await call(`/v1/exchange/markets/${symbol}/depth`, { token: 'alice' })).status, 200)
})

test('a market can be named by symbol or by id, and an unknown one is a 404', { skip }, async () => {
  const { id, symbol } = await seedExchange()
  const bySymbol = await call(`/v1/exchange/markets/${symbol}`, { token: 'alice' })
  const byId = await call(`/v1/exchange/markets/${id}`, { token: 'alice' })
  assert.equal(bySymbol.status, 200)
  assert.deepEqual(bySymbol.body.market, byId.body.market)
  // One call draws the whole screen: the rules, the band, the top of book and the day.
  assert.equal(bySymbol.body.market.lotSize, LOT.toString())
  assert.deepEqual(bySymbol.body.bbo, { bid: null, ask: null })
  assert.equal(bySymbol.body.ticker.trades, 0)
  assert.equal(bySymbol.body.market.band, null, 'a market that has never traded has no band')

  assert.equal((await call('/v1/exchange/markets/NOPE-EMBER', { token: 'alice' })).status, 404)
})

test('placing an order holds the money and reports it in minor units as a string', { skip }, async () => {
  const { symbol } = await seedExchange()
  const response = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    body: orderBody(symbol),
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.order.status, 'open')
  assert.equal(response.body.order.heldAmount, NOTIONAL.toString())
  assert.equal(typeof response.body.order.heldAmount, 'string')
  // A bigserial rounded by a JSON number would silently reorder the book at scale.
  assert.equal(typeof response.body.order.sequence, 'string')
  assert.deepEqual(response.body.fills, [])

  const balances = await call('/v1/exchange/balances', { token: 'alice' })
  const ember = balances.body.balances.find((b: any) => b.asset === 'EMBER')
  assert.equal(ember.held, NOTIONAL.toString())
  assert.equal(ember.total, '1000000000000')
})

test('a retried placement is a replay, not a second order', { skip }, async () => {
  const { symbol } = await seedExchange()
  const key = freshKey('order')
  const first = await call('/v1/exchange/orders', { method: 'POST', token: 'alice', key, body: orderBody(symbol) })
  const second = await call('/v1/exchange/orders', { method: 'POST', token: 'alice', key, body: orderBody(symbol) })

  assert.equal(first.status, 201)
  assert.equal(second.status, 200, 'a replay is 200; only the first placement is a 201')
  assert.equal(second.body.order.id, first.body.order.id)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from orders`
  assert.equal(rows[0]?.n, 1)
})

test('a key reused for a different order is a 409, not somebody else’s receipt', { skip }, async () => {
  const { symbol } = await seedExchange()
  const key = freshKey('order')
  await call('/v1/exchange/orders', { method: 'POST', token: 'alice', key, body: orderBody(symbol) })
  const different = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    key,
    body: orderBody(symbol, { qty: (TEN_LOTS * 2n).toString() }),
  })
  assert.equal(different.status, 409)
})

test('an order that breaks a market rule is 422 with the code the browser points at a control', { skip }, async () => {
  const { symbol } = await seedExchange()
  // 422 and not 400: the request was well-formed and understood. What was refused is the ORDER.
  const notALot = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    body: orderBody(symbol, { qty: (LOT + 1n).toString() }),
  })
  assert.equal(notALot.status, 422)
  assert.equal(notALot.body.error.code, 'qty_not_a_lot')

  const notATick = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    body: orderBody(symbol, { price: (PRICE + 1n).toString() }),
  })
  assert.equal(notATick.body.error.code, 'price_not_a_tick')
})

test('an order nobody can pay for is a 409 and leaves no row behind', { skip }, async () => {
  const { symbol } = await seedExchange()
  const response = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    body: orderBody(symbol, { qty: (TEN_LOTS * 1_000n).toString() }),
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'insufficient_funds')
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from orders`
  assert.equal(rows[0]?.n, 0)
})

test('a crossing pair fills, and each side sees only its own fills', { skip }, async () => {
  const { symbol } = await seedExchange()
  await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'bob',
    body: orderBody(symbol, { side: 'sell' }),
  })
  const taken = await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })
  assert.equal(taken.body.order.status, 'filled')
  assert.equal(taken.body.fills.length, 1)
  assert.equal(taken.body.fills[0].role, 'taker')
  assert.equal(taken.body.order.averagePrice, PRICE.toString())

  const mine = await call('/v1/exchange/fills', { token: 'alice' })
  const theirs = await call('/v1/exchange/fills', { token: 'bob' })
  assert.equal(mine.body.fills.length, 1)
  assert.equal(mine.body.fills[0].role, 'taker')
  assert.equal(theirs.body.fills[0].role, 'maker')

  // The public tape carries the trade and names nobody: a book that published counterparties would
  // let anyone reconstruct another customer's position from a screen.
  const tape = await call(`/v1/exchange/markets/${symbol}/trades`, { token: 'bob' })
  assert.equal(tape.body.trades.length, 1)
  assert.equal(tape.body.trades[0].takerSide, 'buy')
  assert.equal(JSON.stringify(tape.body).includes(ALICE), false)
  assert.equal(JSON.stringify(tape.body).includes(BOB), false)
})

test('depth, ticker and candles are drawn from the trades and not from a counter', { skip }, async () => {
  const { symbol } = await seedExchange()
  await call('/v1/exchange/orders', { method: 'POST', token: 'bob', body: orderBody(symbol, { side: 'sell' }) })
  await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })
  await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'bob',
    body: orderBody(symbol, { side: 'sell', qty: LOT.toString() }),
  })

  const depth = await call(`/v1/exchange/markets/${symbol}/depth`, { token: 'alice' })
  assert.deepEqual(depth.body.depth.asks, [{ price: PRICE.toString(), qty: LOT.toString(), orders: 1 }])

  const day = await call(`/v1/exchange/markets/${symbol}/ticker`, { token: 'alice' })
  assert.equal(day.body.ticker.last, PRICE.toString())
  assert.equal(day.body.ticker.baseVolume, TEN_LOTS.toString())
  assert.equal(day.body.ticker.trades, 1)

  const candles = await call(`/v1/exchange/markets/${symbol}/candles?interval=5m`, { token: 'alice' })
  assert.equal(candles.body.interval, '5m')
  assert.equal(candles.body.candles.length, 1)
  assert.equal(candles.body.candles[0].close, PRICE.toString())

  assert.equal((await call(`/v1/exchange/markets/${symbol}/candles?interval=3s`, { token: 'alice' })).status, 400)
})

test('an order’s own history says why it did what it did', { skip }, async () => {
  const { symbol } = await seedExchange()
  const placed = await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })
  const id = placed.body.order.id
  await call(`/v1/exchange/orders/${id}`, { method: 'DELETE', token: 'alice' })

  const events = await call(`/v1/exchange/orders/${id}/events`, { token: 'alice' })
  assert.deepEqual(events.body.events.map((e: any) => e.kind), ['accepted', 'cancelled'])
  assert.equal(events.body.events[1].detail, 'cancelled_by_owner')
})

test('cancelling twice is a 409, and cancelling somebody else’s order does not confirm it exists', { skip }, async () => {
  const { symbol } = await seedExchange()
  const placed = await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })
  const id = placed.body.order.id

  const first = await call(`/v1/exchange/orders/${id}`, { method: 'DELETE', token: 'alice' })
  assert.equal(first.status, 200)
  assert.equal(first.body.order.status, 'cancelled')

  // No idempotency key on this route by design: the order id IS the key, and answering 200 to a
  // cancel that cancelled nothing is how somebody ends up believing they are flat.
  const again = await call(`/v1/exchange/orders/${id}`, { method: 'DELETE', token: 'alice' })
  assert.equal(again.status, 409)
  assert.equal(again.body.error.code, 'order_state')

  const nosy = await call(`/v1/exchange/orders/${id}`, { method: 'DELETE', token: 'bob' })
  assert.equal(nosy.body.error.message, 'no such order')
  assert.equal((await call(`/v1/exchange/orders/${id}`, { token: 'bob' })).status, 404)
})

test('the panic button pulls everything and replays the first attempt’s list', { skip }, async () => {
  const { symbol } = await seedExchange()
  await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })
  await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    body: orderBody(symbol, { side: 'sell', price: (PRICE * 3n).toString() }),
  })

  const key = freshKey('panic')
  const first = await call('/v1/exchange/orders/cancel-all', { method: 'POST', token: 'alice', key, body: {} })
  assert.equal(first.status, 200)
  assert.equal(first.body.cancelled.length, 2)

  // The honest answer to "what did my panic button cancel" is the list the FIRST attempt produced,
  // not the empty list a retry finds. That is only possible because the claim and the cancels share
  // one transaction.
  const replay = await call('/v1/exchange/orders/cancel-all', { method: 'POST', token: 'alice', key, body: {} })
  assert.equal(replay.body.cancelled.length, 2)

  const open = await call('/v1/exchange/orders?open=true', { token: 'alice' })
  assert.equal(open.body.orders.length, 0)
})

test('a deposit settles inline and a retry re-reads it rather than moving money twice', { skip }, async () => {
  await seedExchange()
  const key = freshKey('xfer')
  const body = { direction: 'deposit', asset: 'BTC', amount: '5000' }
  const first = await call('/v1/exchange/transfers', { method: 'POST', token: 'alice', key, body })
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.outcome, 'settled')
  assert.equal(first.body.transfer.amount, '5000')

  const replay = await call('/v1/exchange/transfers', { method: 'POST', token: 'alice', key, body })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.transfer.id, first.body.transfer.id)
  // The stored response is the transfer id and nothing else, so a replay reads CURRENT state — and
  // the ledger sees one entry however many times the request is retried.
  assert.equal(ledger.entries.length, 1)

  const listed = await call('/v1/exchange/transfers', { token: 'alice' })
  assert.equal(listed.body.transfers.length, 1)
})

test('an asset the estate has retired cannot be moved into custody', { skip }, async () => {
  await seedExchange()
  const response = await call('/v1/exchange/transfers', {
    method: 'POST',
    token: 'alice',
    body: { direction: 'deposit', asset: 'SHARD', amount: '1' },
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /cannot be moved into exchange custody/)
})

test('halting a market is an operator’s job, and a halted market accepts nothing', { skip }, async () => {
  const { symbol } = await seedExchange()
  const refused = await call(`/v1/exchange/markets/${symbol}/status`, {
    method: 'POST',
    token: 'alice',
    body: { status: 'halted' },
  })
  assert.equal(refused.status, 403)

  const halted = await call(`/v1/exchange/markets/${symbol}/status`, {
    method: 'POST',
    token: 'admin',
    body: { status: 'halted' },
  })
  assert.equal(halted.status, 200)
  assert.equal(halted.body.market.status, 'halted')

  const order = await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })
  assert.equal(order.status, 422)
  assert.equal(order.body.error.code, 'market_halted')

  const bad = await call(`/v1/exchange/markets/${symbol}/status`, {
    method: 'POST',
    token: 'admin',
    body: { status: 'closed-for-lunch' },
  })
  assert.equal(bad.status, 400)
})

test('a mutating exchange route without an idempotency key is refused', { skip }, async () => {
  const { symbol } = await seedExchange()
  const response = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'alice',
    key: null,
    body: orderBody(symbol),
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /idempotency-key/)
})

test('a flood is refused with a 429 and a retry-after a client can honour', { skip }, async () => {
  await seedExchange()
  // Twenty a minute for transfers, and the limit is consumed BEFORE the body is read — so a client
  // in an error loop cannot hold its own counter down by sending requests that fail validation.
  const flood = { direction: 'nonsense', asset: 'BTC', amount: '1' }
  for (let i = 0; i < 20; i += 1) {
    const response = await call('/v1/exchange/transfers', { method: 'POST', token: 'alice', body: flood })
    assert.equal(response.status, 400, `request ${i} should have reached validation`)
  }
  const limited = await call('/v1/exchange/transfers', { method: 'POST', token: 'alice', body: flood })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.error.code, 'rate_limited')
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)

  // And another customer is unaffected: the bucket is per subject, not per route.
  assert.equal((await call('/v1/exchange/transfers', { method: 'POST', token: 'bob', body: flood })).status, 400)
})

test('an admin may read a customer’s orders, and a customer may not read anyone else’s', { skip }, async () => {
  const { symbol } = await seedExchange()
  await call('/v1/exchange/orders', { method: 'POST', token: 'alice', body: orderBody(symbol) })

  const asAdmin = await call(`/v1/exchange/orders?userId=${ALICE}`, { token: 'admin' })
  assert.equal(asAdmin.body.orders.length, 1)
  // Bob naming Alice is a 403 and not an empty list. Quietly substituting his own id would answer a
  // question he did not ask, and a client that believed the answer would report "Alice has no open
  // orders" to somebody who is not allowed to know either way.
  const asBob = await call(`/v1/exchange/orders?userId=${ALICE}`, { token: 'bob' })
  assert.equal(asBob.status, 403)
  assert.equal((await call('/v1/exchange/orders', { token: 'bob' })).body.orders.length, 0)
})

test('a service without the write scope may read the book but not trade on it', { skip }, async () => {
  const { symbol } = await seedExchange()
  assert.equal((await call('/v1/exchange/markets', { token: 'svc-none' })).status, 403)
  assert.equal((await call('/v1/exchange/markets', { token: 'svc-write' })).status, 200)
  const placed = await call('/v1/exchange/orders', {
    method: 'POST',
    token: 'svc-write',
    body: { ...orderBody(symbol), userId: ALICE },
  })
  assert.equal(placed.status, 201, JSON.stringify(placed.body))
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
