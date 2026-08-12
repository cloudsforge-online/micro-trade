/**
 * The performance fee, and the four invariants.
 *
 * Every test here is named for a way somebody could be overcharged, and each one drives the failure
 * that caused it rather than merely asserting the fix. The fake ledger can commit a charge and then
 * lose the answer, which is the shape of the timeout the frozen service wrote off as a refusal — the
 * mistake that billed the same arrears twice under two different keys.
 *
 * 14 §5 makes one of these mandatory: "Exactly one `fee_settlement` row per `(bot_id, period)`",
 * driven by two replicas running the sweep while a third process issues a stop. That is
 * `two sweeps and a stop racing one period produce exactly one settlement`.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { listSettlements, periodFor, settle, stopBot, type FeeDeps } from './fees.ts'
import { getBot, insertBot, startBot, updateBot, type BotRecord } from './bots.ts'
import { settlementIdempotencyKey } from './ledgerclient.ts'
import { RATE_SCALE } from './money.ts'
import {
  ALICE,
  enabled,
  fakeLedger,
  makeBars,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTrade,
  seedSeries,
  skip,
  testClock,
  type FakeLedger,
  type TestClock,
} from './testsupport.ts'
import { withOutbox, type Db } from './outbox.ts'
import { SERVICE } from './topics.ts'

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger
let clock: TestClock
let seriesId: string

const PERIOD_SECONDS = 3_600
const ALLOCATION = 1_000_000n

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
  ledger.setBalance(ALICE, 10_000_000n)
  clock = testClock()
  seriesId = await seedSeries(db, makeBars({ count: 10 }))
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

function deps(overrides: Partial<FeeDeps> = {}): FeeDeps {
  return {
    sql: db,
    ledger,
    clock,
    logger: quietLogger(),
    periodSeconds: PERIOD_SECONDS,
    correlationId: 'req-1',
    ...overrides,
  }
}

/** A running live bot whose equity has grown to `equity`, so there is a gain to bill. */
async function aBot(equity = ALLOCATION): Promise<BotRecord> {
  const created = await insertBot(db, {
    userId: ALICE,
    name: 'a bot',
    mode: 'live',
    seriesId,
    strategyId: 'buy_hold',
    params: {},
    allocation: ALLOCATION,
    feeBps: 1_500,
  })
  const started = await startBot(
    { sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: true },
    created,
  )
  if (equity !== ALLOCATION) await updateBot(db, started.id, { equity, equityPriceSource: 'market' })
  return (await getBot(db, started.id)) as BotRecord
}

const rowsFor = (botId: string) => listSettlements(db, botId, 100)

/* ------------------------------------------------------------------ nothing to bill */

test('a bot under its high-water mark is billed nothing and writes no row at all', { skip }, async () => {
  // A settlement history full of "billed you nothing" entries buries the ones that matter.
  const bot = await aBot(900_000n)
  const outcome = await settle(deps(), bot)
  assert.equal(outcome.settlement, null)
  assert.equal((await rowsFor(bot.id)).length, 0)
  assert.equal(ledger.entries.length, 1, 'only the capital reservation should have posted')
})

test('a gain too small to bill accumulates rather than being forgiven', { skip }, async () => {
  // The mark must not advance either: a gain under the floor is billed later, not never.
  const bot = await aBot(ALLOCATION + 10n)
  const outcome = await settle(deps(), bot)
  assert.equal(outcome.settlement, null)
  const after = await getBot(db, bot.id)
  assert.equal(after?.highWaterMark, ALLOCATION, 'the mark advanced past an unbilled gain')
})

/* ------------------------------------------------------------------ the happy path */

test('a gain above the mark is billed once, and the mark advances past it', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  const outcome = await settle(deps(), bot)
  assert.ok(outcome.settlement)
  // 15% of a 100,000 gain.
  assert.equal(outcome.settlement.fee, 15_000n)
  assert.equal(outcome.settlement.collected, 15_000n)
  assert.equal(outcome.settlement.status, 'charged')

  const after = await getBot(db, bot.id)
  assert.equal(after?.highWaterMark, 1_100_000n)
  assert.equal(after?.feePaid, 15_000n)
  assert.equal(after?.feeOwed, 0n)
})

test('the same gain is not billed again on the next period, because the mark moved', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)
  const after = await getBot(db, bot.id)
  assert.ok(after)

  clock.advance(PERIOD_SECONDS * 1000)
  const second = await settle(deps(), after)
  assert.equal(second.settlement, null, 'the same gain was billed twice')
})

test('a bot that loses and wins the same money back pays nothing for the recovery', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)
  const billed = await getBot(db, bot.id)
  assert.ok(billed)

  // Down to 900,000, then back to exactly where it was billed.
  clock.advance(PERIOD_SECONDS * 1000)
  await updateBot(db, bot.id, { equity: 900_000n, equityPriceSource: 'market' })
  await settle(deps(), (await getBot(db, bot.id)) as BotRecord)

  clock.advance(PERIOD_SECONDS * 1000)
  await updateBot(db, bot.id, { equity: 1_100_000n, equityPriceSource: 'market' })
  const outcome = await settle(deps(), (await getBot(db, bot.id)) as BotRecord)
  assert.equal(outcome.settlement, null, 'the recovery was billed')

  const final = await getBot(db, bot.id)
  assert.equal(final?.feePaid, 15_000n, 'the bot paid more than once for one gain')
})

/* ------------------------------------------------------------------ INVARIANT 0 */

test('one period produces one settlement row, whatever tries to write a second', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)
  // A second pass in the same period, from a stale snapshot that still thinks there is a gain.
  const second = await settle(deps(), bot)
  assert.equal(second.settlement, null)
  assert.match(second.deferred ?? '', /already settled/)
  assert.equal((await rowsFor(bot.id)).length, 1)
})

test('two sweeps and a stop racing one period produce exactly one settlement', { skip }, async () => {
  // 14 §5's mandatory concurrency test. The frozen service mints `randomUUID()` per row and has no
  // unique constraint, so this scenario produces TWO rows, TWO idempotency keys, and the upstream
  // honours both.
  const bot = await aBot(1_100_000n)

  const attempts = await Promise.allSettled([
    settle(deps({ correlationId: 'sweep-a' }), bot),
    settle(deps({ correlationId: 'sweep-b' }), bot),
    settle(deps({ correlationId: 'stop' }), bot),
  ])
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'fulfilled', `a racing pass threw: ${String((attempt as PromiseRejectedResult).reason)}`)
  }

  const rows = await rowsFor(bot.id)
  assert.equal(rows.length, 1, `expected one settlement row, got ${rows.length}`)

  const period = periodFor(clock, PERIOD_SECONDS)
  const feeKeys = ledger.keys.filter((key) => key.startsWith('trade:settlement:'))
  assert.deepEqual(new Set(feeKeys), new Set([settlementIdempotencyKey(bot.id, period)]))

  const charges = ledger.entries.filter((entry) => entry.kind === 'performance_fee')
  assert.equal(charges.length, 1, 'the user was charged more than once')

  const after = await getBot(db, bot.id)
  assert.equal(after?.feePaid, 15_000n)
})

test('ten concurrent passes over one period still charge exactly once', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  await Promise.allSettled(Array.from({ length: 10 }, () => settle(deps(), bot)))
  assert.equal((await rowsFor(bot.id)).length, 1)
  assert.equal(ledger.entries.filter((entry) => entry.kind === 'performance_fee').length, 1)
})

/* ------------------------------------------------------------------ INVARIANT 1 */

test('the mark never moves down, so the climb back is not billed a second time', { skip }, async () => {
  // The frozen bug: a pass carrying arrears while equity had FALLEN still assigned `bot.equity` to
  // the mark, dragging it down — and the climb back to the original mark was billed all over again.
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)
  assert.equal((await getBot(db, bot.id))?.highWaterMark, 1_100_000n)

  // Now under water, but carrying arrears, which is what makes the total billable.
  clock.advance(PERIOD_SECONDS * 1000)
  await updateBot(db, bot.id, { equity: 800_000n, equityPriceSource: 'market', feeOwed: 5_000n })
  await settle(deps(), (await getBot(db, bot.id)) as BotRecord)

  assert.equal((await getBot(db, bot.id))?.highWaterMark, 1_100_000n, 'the mark was dragged down')
})

test('an arrears pass has no opinion about the mark at all', { skip }, async () => {
  const bot = await aBot(2_000_000n)
  await updateBot(db, bot.id, { feeOwed: 1_000n, status: 'paused' })
  const paused = (await getBot(db, bot.id)) as BotRecord

  await settle(deps(), paused, 'arrears')
  const after = await getBot(db, bot.id)
  // The bot is far above its mark, and an arrears pass must NOT bill that unrealised gain.
  assert.equal(after?.highWaterMark, ALLOCATION, 'an arrears pass advanced the mark')
  const rows = await rowsFor(bot.id)
  assert.equal(rows[0]?.fee, 1_000n, 'an arrears pass assessed a new fee')
  assert.equal(rows[0]?.gain, 0n)
})

/* ------------------------------------------------------------------ INVARIANT 3 */

test('the debt is recorded before the row exists, so every later crash can only under-collect', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  // Unreachable only from here, so the failure under test is the CHARGE rather than the bot failing
  // to reserve its capital and never starting at all.
  ledger.failNext(1)
  const outcome = await settle(deps(), bot)

  // The charge did not land, but `feeOwed` and the advanced mark are already written.
  const after = await getBot(db, bot.id)
  assert.equal(after?.feeOwed, 15_000n, 'the debt was not recorded before the charge was attempted')
  assert.equal(after?.highWaterMark, 1_100_000n)
  assert.ok(outcome.deferred)
})

/* ------------------------------------------------------------------ INVARIANT 4 */

test('an unknown outcome leaves the row pending rather than writing it off', { skip }, async () => {
  ledger.commitThenLoseAnswer(1)
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)

  const rows = await rowsFor(bot.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, 'pending', 'a lost answer was written off as uncollectable')
})

test('nothing new is assessed while an earlier outcome is unknown', { skip }, async () => {
  // Invariant 4. Assessing on top of arrears that may already be sitting at the ledger under a key
  // we hold would insert a second row for the same debt under a second key.
  ledger.commitThenLoseAnswer(1)
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)

  // A later period, with a further gain. It must be deferred, not billed.
  clock.advance(PERIOD_SECONDS * 1000)
  ledger.failNext(99) // the ledger stays unreachable, so the pending row stays undecided
  await updateBot(db, bot.id, { equity: 2_000_000n, equityPriceSource: 'market' })
  const second = await settle(deps(), (await getBot(db, bot.id)) as BotRecord)

  assert.equal(second.settlement, null)
  assert.match(second.deferred ?? '', /unresolved/)
  assert.equal((await rowsFor(bot.id)).length, 1, 'a second row was written while the first was undecided')
})

test('a lost answer is collected exactly once when the next pass replays the same key', { skip }, async () => {
  // THE double-billing test. One commit at the ledger, two passes over it, one charge.
  ledger.commitThenLoseAnswer(1)
  const bot = await aBot(1_100_000n)
  await settle(deps(), bot)

  clock.advance(PERIOD_SECONDS * 1000)
  const resolved = await settle(deps(), (await getBot(db, bot.id)) as BotRecord)

  const charges = ledger.entries.filter((entry) => entry.kind === 'performance_fee')
  assert.equal(charges.length, 1, 'the user was charged twice for one settlement')

  const rows = await rowsFor(bot.id)
  assert.equal(rows.length, 1, 'a second row was written for a debt that had already been paid')
  assert.equal(rows[0]?.status, 'charged')
  assert.equal(rows[0]?.collected, 15_000n)

  const after = await getBot(db, bot.id)
  assert.equal(after?.feePaid, 15_000n)
  assert.equal(after?.feeOwed, 0n)
  void resolved
})

/* ------------------------------------------------------------------ refusal and partials */

test('a wallet that cannot cover the fee is a decided refusal, and the debt stays owed', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  ledger.setBalance(ALICE, 0n)
  const outcome = await settle(deps(), bot)

  assert.equal(outcome.settlement?.status, 'uncollectable')
  const after = await getBot(db, bot.id)
  assert.equal(after?.feeOwed, 15_000n, 'the debt was forgiven rather than carried')
  assert.equal(after?.feePaid, 0n)
})

test('a short wallet is charged what it can cover, under the same key and not a second one', { skip }, async () => {
  // Invariant 2. The frozen service handled this by charging a smaller amount under a SECOND key; a
  // crash between that charge and the row update left a pending row the next pass re-sent in FULL
  // under the first key, and both landed.
  const bot = await aBot(1_100_000n)
  ledger.setBalance(ALICE, 6_000n)
  const outcome = await settle(deps(), bot)

  assert.equal(outcome.settlement?.status, 'partial')
  assert.equal(outcome.settlement?.collected, 6_000n)
  assert.equal(outcome.settlement?.attempted, 6_000n, 'the lowered amount was not written to the row')

  const period = periodFor(clock, PERIOD_SECONDS)
  const feeKeys = new Set(ledger.keys.filter((key) => key.startsWith('trade:settlement:')))
  assert.deepEqual(feeKeys, new Set([settlementIdempotencyKey(bot.id, period)]), 'a second key was minted')

  const after = await getBot(db, bot.id)
  assert.equal(after?.feePaid, 6_000n)
  assert.equal(after?.feeOwed, 9_000n, 'the uncollected remainder was not carried')
})

/**
 * A partial collection is a different fact from a full one, and it says so — micro-org#367.
 *
 * ## The mutation this kills
 *
 * A CONSTANT status on the emit. `status: 'charged'` for every collection is exactly what the
 * payload said implicitly before this, by carrying no status at all: `{ settlementId, botId,
 * period, collected, entryId }` is byte-identical whether the wallet covered the whole fee or a
 * twentieth of it, and both `activity` and `notify` wrote that limit into their own rules on
 * 2026-08-10 rather than hedging the copy. Any revenue figure built on this topic would read
 * `collected` as the assessment and overstate what the platform is owed the moment one wallet
 * comes up short.
 *
 * ONE case cannot kill that mutation, which is why there are two here and why they share
 * everything but the balance. A test that drove only the short wallet dies to `status: 'partial'`
 * hard-coded; one that drove only the full wallet dies to `'charged'`. The pair pins the field to
 * the settlement it describes.
 *
 * It is driven through `withOutbox` and read back out of the `outbox` TABLE — the exact shape
 * `jobs.ts`'s settle handler uses — so it also kills deleting the emit outright, which a spy on
 * `emit` would not: the fill emit on this service was optional and unpassed for a fortnight while
 * every suite stayed green.
 */
test('a partial fee collection says so on the wire, and a full one says something else', { skip }, async () => {
  const full = await aBot(1_100_000n)
  const short = await aBot(1_100_000n)

  await withOutbox(db, SERVICE, async (_tx, emit) => settle(deps(), full, 'assess', emit))
  // The only difference between the two settlements. 15,000 cents are due on each.
  ledger.setBalance(ALICE, 6_000n)
  await withOutbox(db, SERVICE, async (_tx, emit) => settle(deps(), short, 'assess', emit))

  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where topic = 'trade.fee.settled' order by occurred_at asc
  `
  assert.equal(rows.length, 2, 'a fee left a balance and the estate was told nothing')
  const [charged, partial] = rows.map((row) => row.payload)

  assert.equal(charged?.['status'], 'charged')
  assert.equal(charged?.['collected'], '15000')
  assert.equal(charged?.['due'], '15000')

  assert.equal(partial?.['status'], 'partial')
  assert.equal(partial?.['collected'], '6000')
  // `due` is what makes the shortfall computable by a consumer that holds no settlement row. The
  // reverse is not derivable, which is why the assessment is sent rather than the remainder.
  assert.equal(partial?.['due'], '15000')
})

test('a balance the ledger will not report defers, rather than being read as zero', { skip }, async () => {
  // Reading "do not know" as zero would retire a row on the strength of an outage.
  const bot = await aBot(1_100_000n)
  ledger.setBalance(ALICE, 100n)
  ledger.hideBalance(true)
  const outcome = await settle(deps(), bot)

  assert.equal(outcome.settlement?.status, 'pending')
  assert.ok(outcome.deferred)
  const after = await getBot(db, bot.id)
  assert.equal(after?.feeOwed, 15_000n)
})

test('arrears no wallet can cover write no new row, however many periods pass', { skip }, async () => {
  // A stopped bot's equity never changes again, so without this an identical uncollectable row would
  // be produced every period, for ever, burying the settlements that actually charged something.
  const bot = await aBot()
  await updateBot(db, bot.id, { feeOwed: 500n, status: 'stopped' })
  ledger.setBalance(ALICE, 0n)

  for (let i = 0; i < 5; i++) {
    clock.advance(PERIOD_SECONDS * 1000)
    const outcome = await settle(deps(), (await getBot(db, bot.id)) as BotRecord, 'arrears')
    assert.equal(outcome.settlement, null)
    assert.match(outcome.deferred ?? '', /cannot cover/)
  }
  assert.equal((await rowsFor(bot.id)).length, 0)
})

test('a refused row is retired so the pending set cannot block every later assessment', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  ledger.setBalance(ALICE, 0n)
  await settle(deps(), bot)
  assert.equal((await rowsFor(bot.id))[0]?.status, 'uncollectable')

  // Money arrives, a later period assesses again, and the earlier refusal does not stand in the way.
  clock.advance(PERIOD_SECONDS * 1000)
  ledger.setBalance(ALICE, 1_000_000n)
  await updateBot(db, bot.id, { equity: 1_200_000n, equityPriceSource: 'market' })
  const outcome = await settle(deps(), (await getBot(db, bot.id)) as BotRecord)
  assert.equal(outcome.settlement?.status, 'charged')
})

/* ------------------------------------------------------------------ period arithmetic */

test('the period is a floor of the clock, so every replica agrees without asking the others', () => {
  const at = testClock(7_200_000)
  assert.equal(periodFor(at, 3_600), 2n)
  at.advance(3_599_000)
  assert.equal(periodFor(at, 3_600), 2n, 'the period changed inside its own window')
  at.advance(1_000)
  assert.equal(periodFor(at, 3_600), 3n)
})

/* ------------------------------------------------------------------ stopping */

test('stopping releases the capital reservation and settles the realised gain', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  assert.ok(bot.reservationEntryId)

  const outcome = await stopBot(
    { ...deps(), producer: 'trade', markEquity: async () => ({ equity: 1_100_000n, priceSource: 'market' }) },
    bot,
  )
  const after = await getBot(db, bot.id)
  assert.equal(after?.status, 'stopped')
  assert.equal(after?.reservationEntryId, null, 'the capital was left reserved')
  assert.equal(outcome.settlement?.collected, 15_000n)
})

test('stopping without a usable price reconciles arrears instead of billing an unmarked gain', { skip }, async () => {
  const bot = await aBot(2_000_000n)
  const outcome = await stopBot(
    { ...deps(), producer: 'trade', markEquity: async () => null },
    bot,
  )
  assert.equal(outcome.settlement, null, 'an unmarkable gain was billed')
  const after = await getBot(db, bot.id)
  assert.equal(after?.status, 'stopped')
  assert.equal(after?.highWaterMark, ALLOCATION, 'the mark advanced without a price to justify it')
})

test('a bot always stops, even when the settlement on the way out cannot complete', { skip }, async () => {
  const bot = await aBot(1_100_000n)
  ledger.failNext(99)
  await stopBot({ ...deps(), producer: 'trade', markEquity: async () => ({ equity: 1_100_000n, priceSource: 'market' }) }, bot)
  assert.equal((await getBot(db, bot.id))?.status, 'stopped', 'a bot the operator stopped kept running')
})

test('a paper bot is never charged, because nothing about a simulation is billable', { skip }, async () => {
  const created = await insertBot(db, {
    userId: ALICE,
    name: 'paper',
    mode: 'paper',
    seriesId,
    strategyId: 'buy_hold',
    params: {},
    allocation: ALLOCATION,
    feeBps: 1_500,
  })
  const started = await startBot(
    { sql: db, ledger, producer: 'trade', correlationId: 'r', liveEnabled: true },
    created,
  )
  // No reservation is taken for a paper bot either.
  assert.equal(started.reservationEntryId, null)
  assert.equal(ledger.entries.length, 0)
})

void RATE_SCALE
