/**
 * The bot tick, and the races around it.
 *
 * The centrepiece is "two workers, one bot tick, one execution". It is driven through the **real**
 * `JobQueue` and `JobRunner` against a real Postgres, with two runners under different owners
 * claiming from one table — because the bug class being tested is precisely one that a module-local
 * latch cannot see. The frozen service's only guard is `let running = false`
 * (`crucible/services/crucible/src/runner.ts`), which is invisible to a second process, and that
 * is why it cannot be scaled past one replica.
 *
 * The other half of this file is refusal: a bot that cannot get a price, or whose data has stopped
 * updating, or whose kill switch is off, must do NOTHING rather than trade on a default.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Logger } from '@cloudsforge/telemetry'
import {
  LIVE_DISABLED,
  getBot,
  insertBot,
  pauseBot,
  planRebalance,
  runningBotIds,
  startBot,
  tickBot,
  unsettledBotIds,
  updateBot,
  type BotRecord,
  type TickDeps,
} from './bots.ts'
import { getSeries } from './series.ts'
import { registerHandlers, TICK_KIND, TICK_SWEEP_KIND } from './jobs.ts'
import { RATE_SCALE, valueInCents } from './money.ts'
import {
  ALICE,
  enabled,
  fakeLedger,
  fakePricing,
  makeBars,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTrade,
  seedSeries,
  skip,
  testClock,
  type FakeLedger,
  type FakePricing,
  type TestClock,
} from './testsupport.ts'
import { buildEnvelope, type Db } from './outbox.ts'
import { envelopeDefects } from './topics.ts'

/**
 * The relay's own row shape, restated here because `outbox.ts` keeps it private.
 *
 * Structural, so `buildEnvelope` accepts it: the point of reading a REAL row back out of the table
 * and building the envelope from it is that nothing in this file gets to invent what a producer
 * sends. A fixture envelope proves a fixture.
 */
interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger
let pricing: FakePricing
let clock: TestClock
let seriesId: string

/** The bars every test runs against. The newest one closes exactly at the harness clock. */
const BAR_WIDTH = 3_600
const BARS = makeBars({ count: 300, shape: 'sawtooth', widthSeconds: BAR_WIDTH })
const NEWEST = BARS[BARS.length - 1] as (typeof BARS)[number]
/** One second after the newest bar closed: fresh, by one second. */
const FRESH_MS = (NEWEST.t + BAR_WIDTH + 1) * 1000

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetTrade(sql)
  ledger = fakeLedger()
  ledger.setBalance(ALICE, 100_000_000n)
  pricing = fakePricing()
  pricing.set('BTC', 30_000n * RATE_SCALE)
  clock = testClock(FRESH_MS)
  seriesId = await seedSeries(db, BARS)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

function tickDeps(overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    sql: db,
    ledger,
    pricing,
    clock,
    logger: quietLogger(),
    producer: 'trade',
    liveEnabled: true,
    correlationId: 'req-1',
    ...overrides,
  }
}

async function aBot(mode: 'paper' | 'live' = 'paper', allocation = 1_000_000n): Promise<BotRecord> {
  const bot = await insertBot(db, {
    userId: ALICE,
    name: 'a bot',
    mode,
    seriesId,
    strategyId: 'buy_hold',
    params: {},
    allocation,
    feeBps: 1_500,
  })
  return startBot(
    { sql: db, ledger, producer: 'trade', correlationId: 'req-1', liveEnabled: true },
    bot,
  )
}

async function fillCount(botId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from fills where bot_id = ${botId}`
  return rows[0]?.n ?? 0
}

/* ------------------------------------------------------------------ planning, pure */

test('a rebalance below the minimum is not worth its cost and is not planned', () => {
  // A bot already at its target drifts by a rounding step, which is far under the 50 bp threshold.
  // Without a threshold a fractional rule re-trades that step every bar and pays a fee for it, which
  // quietly turns a profitable rule into a losing one.
  const price = 30_000n * RATE_SCALE
  const units = 16_666_666n // worth ~499,999 cents at the price above
  const held = valueInCents(units, 'BTC', price)
  assert.equal(planRebalance(5_000, held, units, 'BTC', price), null)
  // A real move is planned.
  assert.equal(planRebalance(10_000, held, units, 'BTC', price)?.side, 'buy')
  assert.equal(planRebalance(0, held, units, 'BTC', price)?.side, 'sell')
})

test('a target of zero plans a sale of the whole position, not of nothing', () => {
  const plan = planRebalance(0, 0n, 100_000_000n, 'BTC', 30_000n * RATE_SCALE)
  assert.equal(plan?.side, 'sell')
  assert.equal(plan?.units, 100_000_000n)
})

test('a plan never spends more cash than the bot holds', () => {
  const plan = planRebalance(10_000, 500n, 0n, 'BTC', 30_000n * RATE_SCALE)
  assert.ok(plan === null || plan.usdCents <= 500n)
})

test('a plan never sells more units than the bot holds', () => {
  const plan = planRebalance(0, 0n, 42n, 'BTC', 30_000n * RATE_SCALE)
  assert.ok(plan === null || plan.units <= 42n)
})

test('nothing is planned at a zero price or against zero equity', () => {
  assert.equal(planRebalance(10_000, 1_000n, 0n, 'BTC', 0n), null)
  assert.equal(planRebalance(10_000, 0n, 0n, 'BTC', 30_000n * RATE_SCALE), null)
})

test('a target above 100% is clamped rather than levering the account', () => {
  const plan = planRebalance(50_000, 1_000_000n, 0n, 'BTC', 30_000n * RATE_SCALE)
  assert.ok(plan)
  assert.ok(plan.usdCents <= 1_000_000n, 'a bot cannot spend more than it has')
})

/* ------------------------------------------------------------------ the tick */

test('a running paper bot fills once against the newest bar', { skip }, async () => {
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps(), bot, series), 'filled')
  assert.equal(await fillCount(bot.id), 1)

  const after = await getBot(db, bot.id)
  assert.ok(after)
  assert.ok(after.position > 0n, 'the bot did not take a position')
  assert.equal(after.lastBarT, NEWEST.t)
})

test('a second tick on the same bar marks to market and does not fill again', { skip }, async () => {
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  await tickBot(tickDeps(), bot, series)
  const afterFirst = await getBot(db, bot.id)
  assert.ok(afterFirst)

  assert.equal(await tickBot(tickDeps(), afterFirst, series), 'marked')
  assert.equal(await fillCount(bot.id), 1)
})

test('a tick never writes cash or position itself, so a crash cannot desync the mirror', { skip }, async () => {
  // The frozen defect: `tickBot` writes cash and position from a pre-trade snapshot alongside an
  // advanced bar pointer. Here the only writer of those two columns is `applyFill`, in the same
  // transaction as the fill row it claims. Asserted by ticking with the ledger refusing: the bar
  // pointer may advance, but the money must not.
  const bot = await aBot('live')
  // Emptied AFTER the capital reservation, so the refusal under test is the FILL being refused
  // rather than the bot failing to start.
  ledger.setBalance(ALICE, 0n)
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  const before = await getBot(db, bot.id)
  assert.ok(before)

  await tickBot(tickDeps(), bot, series)
  const after = await getBot(db, bot.id)
  assert.ok(after)
  assert.equal(after.cash, before.cash, 'cash moved without a settled fill')
  assert.equal(after.position, before.position, 'the position moved without a settled fill')
})

/**
 * `trade.fill.settled` is emitted, and by the TICK — micro-org#367.
 *
 * ## The mutation this kills
 *
 * Restoring `applyFill(sql, id, outcome, emit?)` and dropping the argument at `tickBot`'s two call
 * sites. That is precisely what shipped: the topic was registered, `activity` wrote a classifier
 * for it, `notify` wrote down a decision against it, and on `main` not one had ever arrived —
 * measured 2026-08-11, zero rows on `trade.fill.settled` in the mainnet `outbox`. A test that
 * called `applyFill` directly with an emit would have stayed green through all of it, because
 * `applyFill` emitting was never the thing in doubt. So this drives `tickBot` and reads the OUTBOX,
 * which is the only place a caller's failure to ask for the event is visible.
 *
 * It kills two narrower mutations in the same breath: deleting `userId` from the payload, and
 * deleting the `actor` from the emit. Both were absent on `main` and both are load-bearing in a
 * different consumer — `activity` resolves this topic's owner with `userFromPayload` and `notify`
 * resolves recipients from the envelope actor — so an assertion on one would leave the other free
 * to regress. The envelope is built with the relay's own `buildEnvelope` and run past
 * `envelopeDefects`, so "the estate can read it" is the contract's answer rather than this file's.
 *
 * Paper mode deliberately: it reaches the same `applyFill` with no ledger in the way, so a failure
 * here is about the emit and never about a fake ledger's mood.
 */
test('a fill that settles reaches the bus, attributed to the bot owner rather than to the service', { skip }, async () => {
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps(), bot, series), 'filled')

  const rows = await sql<OutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox where topic = 'trade.fill.settled'
  `
  assert.equal(rows.length, 1, 'the bot filled and the estate was told nothing')

  const envelope = buildEnvelope(rows[0]!)
  assert.equal(envelope.actor, `user:${ALICE}`, 'the envelope names nobody a consumer can deliver to')
  assert.equal(envelope.payload['userId'], ALICE, 'activity reads the owner off the payload for this topic')
  assert.equal(envelope.key, rows[0]!.payload['fillId'], 'the registry keys this topic by the fill')
  assert.deepEqual(
    envelopeDefects(JSON.parse(JSON.stringify(envelope))),
    [],
    'a fill event every consumer in the estate would refuse',
  )
})

test('a bot that is not running does nothing when ticked', { skip }, async () => {
  const bot = await aBot('paper')
  await pauseBot(db, 'trade', bot)
  const paused = await getBot(db, bot.id)
  const series = await getSeries(db, seriesId)
  assert.ok(paused && series)
  assert.equal(await tickBot(tickDeps(), paused, series), 'not_running')
  assert.equal(await fillCount(bot.id), 0)
})

/* ------------------------------------------------------------------ refusal */

test('a stale price refuses the trade rather than settling at a number nobody stands behind', { skip }, async () => {
  // The rule from micro-wallet's pricing client, applied where it moves money: a rate that cannot be
  // quoted is an ERROR, never a default. A fallback rate is a rate at which somebody trades.
  pricing.unset('BTC', 'quote is 900s old, past the 120s maximum')
  const bot = await aBot('live')
  const series = await getSeries(db, seriesId)
  assert.ok(series)

  assert.equal(await tickBot(tickDeps(), bot, series), 'no_price')
  assert.equal(await fillCount(bot.id), 0, 'a bot traded without a usable price')
  const after = await getBot(db, bot.id)
  assert.match(after?.lastError ?? '', /900s old/)
  // And the bar pointer did NOT advance, so the bar is re-evaluated once a price returns.
  assert.equal(after?.lastBarT, null)
})

test('a paper bot does not consult pricing at all, because its money is imaginary', { skip }, async () => {
  pricing.unset('BTC')
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps(), bot, series), 'filled')
})

test('market data that has stopped updating refuses the trade', { skip }, async () => {
  clock.advance(BAR_WIDTH * 1000 * 10)
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps(), bot, series), 'stale')
  assert.equal(await fillCount(bot.id), 0)
  assert.match((await getBot(db, bot.id))?.lastError ?? '', /bars behind/)
})

test('the kill switch stops a running live bot, not only new ones', { skip }, async () => {
  // A kill switch that only applies to bots that do not exist yet is not a kill switch. The switch is
  // read on every tick, not at boot and not at creation.
  const bot = await aBot('live')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps({ liveEnabled: false }), bot, series), 'live_disabled')
  assert.equal(await fillCount(bot.id), 0)
  assert.equal((await getBot(db, bot.id))?.lastError, LIVE_DISABLED)
})

test('the kill switch does not stop a paper bot, because no money moves', { skip }, async () => {
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps({ liveEnabled: false }), bot, series), 'filled')
})

test('a series with too few bars refuses rather than evaluating a rule on nothing', { skip }, async () => {
  const emptyId = await seedSeries(db, [], { symbol: 'ETH-USD', assetCode: 'ETH' })
  const bot = await insertBot(db, {
    userId: ALICE,
    name: 'empty',
    mode: 'paper',
    seriesId: emptyId,
    strategyId: 'buy_hold',
    params: {},
    allocation: 1_000n,
    feeBps: 1_500,
  })
  const running = await startBot(
    { sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: true },
    bot,
  )
  const series = await getSeries(db, emptyId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps(), running, series), 'no_bars')
})

/* ------------------------------------------------------------------ what the mark was taken against */

/**
 * The stored equity says where its price came from — micro-org#368.
 *
 * ## Why this is a PAIR and not one assertion
 *
 * The defect is that an administered mark and a traded mark are byte-identical once stored, so the
 * screen showing them cannot tell a number an operator typed from a number four independent sources
 * agreed on. A test that only proves `administered` is recorded passes just as happily against a
 * `tickBot` that hard-codes the word — which reports every mark as operator-set, the same lie
 * pointing the other way and a worse one, because it teaches a reader to ignore the label. The two
 * bots here differ in exactly one input, what pricing answers, and the assertion is on the
 * difference.
 *
 * Read back through `getBot` rather than off the return of the tick, because the column is the
 * artefact: `bots.equity` outlives the tick that wrote it and is what every later reader sees.
 */
test('two live bots marked at the same number record which of them was priced by a person', { skip }, async () => {
  const series = await getSeries(db, seriesId)
  assert.ok(series)

  // EMBER on this estate: pricing serves it `administered`, because Hearth has no exchange listing.
  pricing.setAdministered('BTC', 30_000n * RATE_SCALE)
  const administered = await aBot('live')
  assert.equal(await tickBot(tickDeps(), administered, series), 'filled')

  pricing.set('BTC', 30_000n * RATE_SCALE)
  const market = await aBot('live')
  assert.equal(await tickBot(tickDeps(), market, series), 'filled')

  const one = await getBot(db, administered.id)
  const other = await getBot(db, market.id)
  assert.equal(one?.equityPriceSource, 'administered')
  assert.equal(other?.equityPriceSource, 'market')
  assert.equal(one?.equity, other?.equity, 'the two marks must be the same number, or this proves nothing')
})

test('a paper bot marks at its own bar close and says so, rather than claiming a quote', { skip }, async () => {
  // Unquotable on purpose: a paper bot never asks pricing, so `market` here would be a provenance
  // for a call that was never made. `bar` is the third case the column exists to be able to state.
  pricing.unset('BTC')
  const bot = await aBot('paper')
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  assert.equal(await tickBot(tickDeps(), bot, series), 'filled')
  assert.equal((await getBot(db, bot.id))?.equityPriceSource, 'bar')
})

test('the mark-only tick carries the provenance too, not just the one that fills', { skip }, async () => {
  // Two write sites in `tickBot` and this is the quieter one: a running bot on a quiet market takes
  // this branch on every tick between bars, so it is the branch that writes the equity a user is
  // most likely to be looking at.
  const series = await getSeries(db, seriesId)
  assert.ok(series)
  const bot = await aBot('live')
  assert.equal(await tickBot(tickDeps(), bot, series), 'filled')

  pricing.setAdministered('BTC', 31_000n * RATE_SCALE)
  const filled = await getBot(db, bot.id)
  assert.ok(filled)
  assert.equal(await tickBot(tickDeps(), filled, series), 'marked')
  assert.equal((await getBot(db, bot.id))?.equityPriceSource, 'administered', 'a re-mark kept the old provenance')
})

test('a bot nothing has marked yet claims no price source at all', { skip }, async () => {
  // `insertBot` seeds `equity` from `allocation`, which is capital committed and not a valuation.
  // Labelling that would be inventing a provenance for a number that has none.
  const bot = await aBot('paper')
  assert.equal(bot.equityPriceSource, null)
})

test('a mark cannot be stored without saying what it was marked against', { skip }, async () => {
  const bot = await aBot('paper')
  await assert.rejects(() => updateBot(db, bot.id, { equity: 1_000n }), /micro-org#368/)
  await assert.rejects(() => updateBot(db, bot.id, { equityPriceSource: 'market' }), /micro-org#368/)
})

/* ------------------------------------------------------------------ lifecycle */

test('starting a live bot reserves its capital before it is allowed to run', { skip }, async () => {
  const bot = await aBot('live')
  assert.equal(bot.status, 'running')
  assert.ok(bot.reservationEntryId, 'a live bot started without a ledger reservation')
})

test('restarting a bot reserves once, because the reservation key is derived from the bot', { skip }, async () => {
  const bot = await aBot('live')
  const again = await startBot(
    { sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: true },
    bot,
  )
  assert.equal(again.reservationEntryId, bot.reservationEntryId)
  assert.equal(ledger.keys.filter((key) => key.startsWith('trade:allocation:')).length, 1)
})

test('a live bot cannot be started while the kill switch is off', { skip }, async () => {
  const bot = await insertBot(db, {
    userId: ALICE,
    name: 'live',
    mode: 'live',
    seriesId,
    strategyId: 'buy_hold',
    params: {},
    allocation: 1_000n,
    feeBps: 1_500,
  })
  await assert.rejects(
    () => startBot({ sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: false }, bot),
    (err: unknown) => (err as Error).name === 'BotStateError',
  )
})

test('a new bot starts its high-water mark at its capital, not at zero', { skip }, async () => {
  // Starting the mark at zero would bill the user a performance fee on their own deposit the first
  // time the bot was settled.
  const bot = await aBot('live', 500_000n)
  assert.equal(bot.highWaterMark, 500_000n)
})

test('a stopped bot cannot be restarted, because its capital has been released', { skip }, async () => {
  const bot = await aBot('paper')
  await updateBot(db, bot.id, { status: 'stopped' })
  const stopped = await getBot(db, bot.id)
  assert.ok(stopped)
  await assert.rejects(
    () => startBot({ sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: true }, stopped),
    (err: unknown) => (err as Error).name === 'BotStateError',
  )
})

test('the running set holds only running bots, and the arrears set only ones that have left it', { skip }, async () => {
  const running = await aBot('paper')
  const other = await aBot('paper')
  await updateBot(db, other.id, { status: 'paused', feeOwed: 500n })

  assert.deepEqual(await runningBotIds(db, 100), [running.id])
  assert.deepEqual(await unsettledBotIds(db, 100), [other.id])
})

test('a paused bot with nothing owed is in neither sweep list', { skip }, async () => {
  const bot = await aBot('paper')
  await pauseBot(db, 'trade', bot)
  assert.deepEqual(await runningBotIds(db, 100), [])
  assert.deepEqual(await unsettledBotIds(db, 100), [])
})

/* ------------------------------------------------------------------ TWO WORKERS */

function makeRunner(owner: string): { queue: JobQueue; runner: JobRunner; ran: string[] } {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner, leaseMs: 30_000 })
  const ran: string[] = []
  const runner = new JobRunner({ queue, concurrency: 4, pollMs: 10_000 })
  // Executions are counted through the REAL logger's sink rather than by stubbing a method: the
  // thing under test is how many times the handler ran, and a stub that missed the call site would
  // report zero and look like a pass on the "no double execution" half of the assertion.
  const recording = new Logger({
    service: 'trade-test',
    sink: (line) => {
      if (line.includes('"msg":"bot tick"')) ran.push(`${owner}:${line}`)
    },
  })
  registerHandlers(runner, {
    sql: db,
    queue,
    logger: recording,
    signingSecret: 'a-real-looking-secret-of-sufficient-length',
    producer: 'trade',
    idempotencyTtlDays: 30,
    tick: {
      sql: db,
      ledger,
      pricing,
      clock,
      logger: quietLogger(),
      producer: 'trade',
      liveEnabled: true,
    },
    fees: {
      sql: db,
      ledger,
      clock,
      logger: quietLogger(),
      periodSeconds: 3_600,
    },
    exchange: { clock, ledger },
  })
  return { queue, runner, ran }
}

test('two workers claiming one bot tick produce exactly one execution', { skip }, async () => {
  const bot = await aBot('paper')

  const a = makeRunner('replica-a')
  const b = makeRunner('replica-b')
  await a.queue.enqueue({ kind: TICK_KIND, key: `bot:${bot.id}`, payload: { botId: bot.id } })

  // Released together, against one Postgres. `for update skip locked` inside `claim` is what makes
  // one of them get nothing rather than both getting the row.
  const [claimedA, claimedB] = await Promise.all([a.runner.tick(), b.runner.tick()])
  assert.equal(claimedA + claimedB, 1, `both workers claimed the tick (${claimedA} + ${claimedB})`)

  while (a.runner.inFlight > 0 || b.runner.inFlight > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(a.ran.length + b.ran.length, 1, 'the handler ran more than once')
  assert.equal(await fillCount(bot.id), 1, 'the bot filled more than once')
})

test('two workers racing ten bot ticks run each of them exactly once', { skip }, async () => {
  const bots = await Promise.all(Array.from({ length: 10 }, () => aBotNamed()))
  const a = makeRunner('replica-a')
  const b = makeRunner('replica-b')
  for (const bot of bots) {
    await a.queue.enqueue({ kind: TICK_KIND, key: `bot:${bot.id}`, payload: { botId: bot.id } })
  }

  await drain(a.runner, b.runner)

  const executions = a.ran.length + b.ran.length
  assert.equal(executions, 10, `expected ten executions, got ${executions}`)
  for (const bot of bots) assert.equal(await fillCount(bot.id), 1, `${bot.id} filled twice`)
})

test('the tick sweep enqueues one job per running bot and no more, however often it runs', { skip }, async () => {
  const bot = await aBot('paper')
  // A runner with no tick handler registered, so the enqueued `bot.tick` rows stay in the table to
  // be counted instead of being claimed and deleted by the same drain.
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'sweeper', leaseMs: 30_000 })
  const runner = new JobRunner({ queue, concurrency: 1, pollMs: 10_000 })
  const a = makeRunner('replica-a')
  void a
  registerSweepOnly(runner, queue)

  await queue.enqueue({ kind: TICK_SWEEP_KIND, key: 'stream' })
  await drain(runner)

  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = ${TICK_KIND} and key = ${`bot:${bot.id}`}
  `
  assert.equal(rows[0]?.n, 1)

  // A second sweep must not double the queue: `(kind, key)` is unique and the conflict is kept.
  await queue.enqueue({ kind: TICK_SWEEP_KIND, key: 'stream' })
  await drain(runner)
  const again = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = ${TICK_KIND}
  `
  assert.equal(again[0]?.n, 1)
})

/**
 * Claim and then WAIT.
 *
 * `JobRunner.tick()` resolves when the batch has been claimed, not when it has been handled — the
 * handlers run on after it. Asserting straight after `tick()` therefore races the work, and the race
 * is one a test wins often enough to look green. Draining `inFlight` is what makes these assertions
 * about the outcome rather than about the scheduler's timing.
 */
async function drain(...runners: readonly JobRunner[]): Promise<void> {
  for (let pass = 0; pass < 50; pass++) {
    const claimed = await Promise.all(runners.map((runner) => runner.tick()))
    while (runners.some((runner) => runner.inFlight > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (claimed.every((count) => count === 0)) return
  }
  throw new Error('the queue did not drain in 50 passes')
}

/** Just the sweep, so the ticks it produces are left in the table where they can be counted. */
function registerSweepOnly(runner: JobRunner, queue: JobQueue): void {
  runner.register(TICK_SWEEP_KIND, async () => {
    for (const id of await runningBotIds(db, 500)) {
      await queue.enqueue({ kind: TICK_KIND, key: `bot:${id}`, payload: { botId: id }, onConflict: 'keep' })
    }
  })
}

let botCounter = 0
async function aBotNamed(): Promise<BotRecord> {
  botCounter += 1
  const bot = await insertBot(db, {
    userId: ALICE,
    name: `bot ${botCounter}`,
    mode: 'paper',
    seriesId,
    strategyId: 'buy_hold',
    params: {},
    allocation: 1_000_000n,
    feeBps: 1_500,
  })
  return startBot({ sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: true }, bot)
}
