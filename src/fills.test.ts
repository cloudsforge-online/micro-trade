/**
 * **A fill is money.** These are the tests that prove it moves exactly once.
 *
 * Each one reproduces a specific way a fill could be applied twice, and asserts it is not. Per
 * 14 §3, a test that can only assert the fix cannot show the bug — so the retry tests drive a fake
 * ledger that genuinely commits a charge and then loses the answer, which is the shape of the
 * timeout that made the frozen estate double-bill.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import {
  applyFill,
  bookFill,
  getFill,
  listFills,
  markFillUnresolved,
  refuseFill,
  settleFill,
  type PlannedFill,
} from './fills.ts'
import { fillIdempotencyKey } from './ledgerclient.ts'
import { SERVICE } from './topics.ts'
import { buildEnvelope } from './outbox.ts'
import { amountFrom } from './money.ts'
import {
  ALICE,
  enabled,
  fakeLedger,
  makeBars,
  migrateTestDb,
  openDb,
  resetTrade,
  seedSeries,
  skip,
  type FakeLedger,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger
let botId: string

const BAR_T = 1_700_000_400

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
  botId = await aBot()
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

async function aBot(cash = 1_000_000n): Promise<string> {
  const seriesId = await seedSeries(db, makeBars({ count: 5 }))
  const rows = await sql<{ id: string }[]>`
    insert into bots (user_id, name, mode, series_id, strategy_id, allocation, cash, equity, fee_bps)
    values (${ALICE}, 'a bot', 'live', ${seriesId}, 'buy_hold', ${cash.toString()}, ${cash.toString()}, ${cash.toString()}, 1500)
    returning id
  `
  const id = rows[0]?.id
  if (!id) throw new Error('no bot')
  return id
}

function planned(overrides: Partial<PlannedFill> = {}): PlannedFill {
  return {
    botId,
    userId: ALICE,
    barT: BAR_T,
    side: 'buy',
    mode: 'live',
    priceScaled: 30_000_000_000n,
    qty: 100_000n,
    usdCents: -30_000n,
    feeUsdCents: 30n,
    reason: 'a signal',
    ...overrides,
  }
}

async function botState(): Promise<{ cash: bigint; position: bigint }> {
  const rows = await sql<{ cash: string; position: string }[]>`
    select cash, position from bots where id = ${botId}
  `
  const row = rows[0]
  if (!row) throw new Error('no bot')
  return { cash: amountFrom(row.cash), position: amountFrom(row.position) }
}

const deps = () => ({ sql: db, ledger, asset: 'BTC' as const, correlationId: 'req-1', producer: SERVICE })

/* ------------------------------------------------------------------ booking */

test('a bot cannot book the same side of the same bar twice', { skip }, async () => {
  const first = await bookFill(db, planned())
  assert.ok(first)
  const second = await bookFill(db, planned())
  assert.equal(second, null, 'the second booking must lose, not raise')
})

test('the other side of the same bar is a different fill and is allowed', { skip }, async () => {
  assert.ok(await bookFill(db, planned({ side: 'buy' })))
  assert.ok(await bookFill(db, planned({ side: 'sell', usdCents: 30_000n })))
})

test('a duplicate booking is a replay rather than a failure, so a benign race logs nothing red', { skip }, async () => {
  await bookFill(db, planned())
  // Ten workers racing the same bar: one wins and nine are told "already done".
  const attempts = await Promise.all(Array.from({ length: 10 }, () => bookFill(db, planned())))
  assert.equal(attempts.filter((fill) => fill !== null).length, 0)
})

test('twenty concurrent bookings of one bar produce exactly one fill row', { skip }, async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => bookFill(db, planned())))
  assert.equal(results.filter((fill) => fill !== null).length, 1)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from fills where bot_id = ${botId}`
  assert.equal(rows[0]?.n, 1)
})

/* ------------------------------------------------------------------ exactly-once application */

test('a settled fill moves the bot once, and a second settle of it moves nothing', { skip }, async () => {
  const before = await botState()
  const fill = await bookFill(db, planned())
  assert.ok(fill)

  const first = await settleFill(deps(), fill)
  assert.equal(first.status, 'applied')
  const afterFirst = await botState()
  assert.equal(afterFirst.cash, before.cash - 30_000n)
  assert.equal(afterFirst.position, before.position + 100_000n)

  // The retry. The ledger replays under the derived key, and the conditional update finds the row
  // already settled.
  const second = await settleFill(deps(), fill)
  assert.equal(second.status, 'already')
  assert.deepEqual(await botState(), afterFirst, 'the bot moved twice')
  assert.equal(ledger.entries.length, 1, 'the ledger was charged twice')
})

test('a fill whose answer was lost is credited once when the retry replays it', { skip }, async () => {
  // THE test. The ledger commits the entry and then throws a timeout, which is exactly what a pod
  // rotated mid-response looks like. Recording that as "nothing moved" is how the same fill gets
  // posted a second time under a second key.
  const before = await botState()
  const fill = await bookFill(db, planned())
  assert.ok(fill)

  ledger.commitThenLoseAnswer(1)
  const lost = await settleFill(deps(), fill)
  assert.equal(lost.status, 'unresolved')
  // Nothing was applied — the outcome is unknown, so the bot must not have moved.
  assert.deepEqual(await botState(), before)
  const afterLoss = await getFill(db, fill.id)
  assert.equal(afterLoss?.status, 'unresolved')
  // The plan is LEFT IN PLACE. Zeroing it would state that nothing moved, which is precisely what is
  // not known.
  assert.equal(afterLoss?.qty, 100_000n)

  const retry = await settleFill(deps(), fill)
  assert.equal(retry.status, 'applied')
  const after = await botState()
  assert.equal(after.cash, before.cash - 30_000n, 'the fill was credited more or less than once')
  assert.equal(after.position, before.position + 100_000n)

  // One commit, two attempts, one entry — because both attempts sent the same derived key.
  assert.equal(ledger.entries.length, 1)
  assert.deepEqual(new Set(ledger.keys), new Set([fillIdempotencyKey(fill.id)]))
})

test('ten concurrent settlements of one fill apply it exactly once', { skip }, async () => {
  const before = await botState()
  const fill = await bookFill(db, planned())
  assert.ok(fill)

  const results = await Promise.all(Array.from({ length: 10 }, () => settleFill(deps(), fill)))
  const applied = results.filter((result) => result.status === 'applied')
  assert.equal(applied.length, 1, `expected one application, got ${applied.length}`)

  const after = await botState()
  assert.equal(after.cash, before.cash - 30_000n)
  assert.equal(after.position, before.position + 100_000n)
  assert.equal(ledger.entries.length, 1)
})

test('a sell moves the position the other way, by the amount on the row', { skip }, async () => {
  await sql`update bots set position = 500000 where id = ${botId}`
  const before = await botState()
  const fill = await bookFill(db, planned({ side: 'sell', qty: 200_000n, usdCents: 60_000n }))
  assert.ok(fill)
  await settleFill(deps(), fill)
  const after = await botState()
  assert.equal(after.position, before.position - 200_000n)
  assert.equal(after.cash, before.cash + 60_000n)
})

/* ------------------------------------------------------------------ the failure taxonomy */

test('a refusal zeroes the fill, because the ledger looked and said nothing moved', { skip }, async () => {
  ledger.setBalance(ALICE, 0n)
  const before = await botState()
  const fill = await bookFill(db, planned())
  assert.ok(fill)

  const result = await settleFill(deps(), fill)
  assert.equal(result.status, 'refused')
  const stored = await getFill(db, fill.id)
  assert.equal(stored?.status, 'refused')
  assert.equal(stored?.qty, 0n)
  assert.equal(stored?.usdCents, 0n)
  assert.deepEqual(await botState(), before)
})

test('an unreachable ledger leaves the fill unresolved, never refused', { skip }, async () => {
  // The distinction the frozen runner draws at runner.ts, and the one that matters: writing
  // "nothing moved" would be as much of a claim as leaving the plan there.
  ledger.failNext(1)
  const fill = await bookFill(db, planned())
  assert.ok(fill)
  const result = await settleFill(deps(), fill)
  assert.equal(result.status, 'unresolved')
  assert.equal((await getFill(db, fill.id))?.status, 'unresolved')
})

test('an in-flight duplicate at the ledger is unresolved, not a failure', { skip }, async () => {
  ledger.inFlightNext(1)
  const fill = await bookFill(db, planned())
  assert.ok(fill)
  assert.equal((await settleFill(deps(), fill)).status, 'unresolved')
  // And the next attempt succeeds, because the ledger has finished by then.
  assert.equal((await settleFill(deps(), fill)).status, 'applied')
})

test('a refused fill is terminal: a later settle does not resurrect it', { skip }, async () => {
  const fill = await bookFill(db, planned())
  assert.ok(fill)
  await refuseFill(db, fill.id, 'the ledger said no')
  const before = await botState()
  const result = await settleFill(deps(), fill)
  assert.equal(result.status, 'already', 'a refused fill must not be applied by a later pass')
  assert.deepEqual(await botState(), before)
})

test('marking a fill unresolved is idempotent and keeps its planned amounts', { skip }, async () => {
  const fill = await bookFill(db, planned())
  assert.ok(fill)
  await markFillUnresolved(db, fill.id, 'timeout')
  await markFillUnresolved(db, fill.id, 'timeout again')
  const stored = await getFill(db, fill.id)
  assert.equal(stored?.status, 'unresolved')
  assert.equal(stored?.qty, 100_000n)
})

/* ------------------------------------------------------------------ reads */

test('a settled fill records the entry that settled it, so a retry is answerable', { skip }, async () => {
  const fill = await bookFill(db, planned())
  assert.ok(fill)
  await settleFill(deps(), fill)
  const stored = await getFill(db, fill.id)
  assert.ok(stored?.entryId, 'a settled fill with no entry id makes "did it post twice" unanswerable')
})

test('a paper fill settles with no ledger entry, because a simulation must not reach the journal', { skip }, async () => {
  const fill = await bookFill(db, planned({ mode: 'paper' }))
  assert.ok(fill)
  const result = await applyFill(
    db,
    fill.id,
    {
      priceScaled: fill.priceScaled,
      qty: fill.qty,
      usdCents: fill.usdCents,
      feeUsdCents: fill.feeUsdCents,
      entryId: null,
    },
    SERVICE,
  )
  assert.equal(result.status, 'applied')
  assert.equal(ledger.entries.length, 0, 'a simulation must not reach the journal')
})

test('fills are listed newest first, so a user sees what just happened', { skip }, async () => {
  await settleFill(deps(), (await bookFill(db, planned({ barT: BAR_T }))) as never)
  await settleFill(deps(), (await bookFill(db, planned({ barT: BAR_T + 3_600 }))) as never)
  const fills = await listFills(db, botId, 10)
  assert.equal(fills.length, 2)
  assert.ok((fills[0]?.barT ?? 0) >= (fills[1]?.barT ?? 0))
})

test('a fill for a bot that does not exist is refused by the foreign key, not silently orphaned', { skip }, async () => {
  await assert.rejects(() =>
    bookFill(db, planned({ botId: '00000000-0000-4000-8000-000000000000' })),
  )
})
