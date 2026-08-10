/**
 * The rate limiter.
 *
 * Against a real database on purpose. The whole argument for counting in Postgres rather than in a
 * `Map` is that two replicas must share one counter — a suite that stubbed the store would test the
 * arithmetic and skip the only property that made the design expensive.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach, describe } from 'node:test'
import type postgres from 'postgres'
import {
  RATE_RULES,
  RateLimitedError,
  REAP_BATCH,
  consumeRate,
  enforceRate,
  reapRateLimits,
  windowStartMs,
} from './ratelimit.ts'
import { enabled, freshKey, migrateTestDb, openDb, resetTrade, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let db: Db

const T0 = Date.parse('2026-07-01T00:00:00.000Z')

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetTrade(sql)
})

after(async () => {
  if (enabled) await sql.end({ timeout: 5 })
})

describe('a rate window', { skip }, () => {
  test('is aligned to the epoch, so two replicas agree without talking', () => {
    assert.equal(windowStartMs(0, 10_000), 0)
    assert.equal(windowStartMs(9_999, 10_000), 0)
    assert.equal(windowStartMs(10_000, 10_000), 10_000)
    // The alignment is the coordination. Were the window measured from a subject's first request,
    // each replica would start its own and the effective limit would be the sum of both.
    assert.equal(windowStartMs(T0 + 4_321, 10_000), windowStartMs(T0 + 9_876, 10_000))
  })
})

describe('counting', { skip }, () => {
  test('spends the quota one request at a time and then refuses', async () => {
    const subject = freshKey('user')
    const limit = RATE_RULES['order.place']?.limit as number

    for (let i = 1; i <= limit; i += 1) {
      const verdict = await consumeRate(db, 'order.place', subject, T0)
      assert.equal(verdict.allowed, true, `request ${i} should have been allowed`)
      assert.equal(verdict.remaining, limit - i)
    }
    const refused = await consumeRate(db, 'order.place', subject, T0)
    assert.equal(refused.allowed, false)
    assert.equal(refused.remaining, 0)
  })

  test('counts the request it refuses, so a retry loop cannot hold its own counter down', async () => {
    const subject = freshKey('user')
    const limit = RATE_RULES['order.place']?.limit as number
    for (let i = 0; i < limit + 5; i += 1) await consumeRate(db, 'order.place', subject, T0)

    const rows = await sql<{ count: number }[]>`
      select count from rate_limits where bucket = ${`order.place:${subject}`}
    `
    assert.equal(Number(rows[0]?.count), limit + 5)
  })

  test('keeps two subjects apart, and two actions apart for one subject', async () => {
    const a = freshKey('user')
    const b = freshKey('user')
    const limit = RATE_RULES['order.place']?.limit as number
    for (let i = 0; i < limit; i += 1) await consumeRate(db, 'order.place', a, T0)

    assert.equal((await consumeRate(db, 'order.place', a, T0)).allowed, false)
    assert.equal((await consumeRate(db, 'order.place', b, T0)).allowed, true)
    // Cancellation is deliberately not spent by placement. A customer who has exhausted their
    // ordering quota must still be able to get out, which is the whole reason the buckets are
    // keyed on the action.
    assert.equal((await consumeRate(db, 'order.cancel', a, T0)).allowed, true)
  })

  test('gives the quota back when the window turns over', async () => {
    const subject = freshKey('user')
    const rule = RATE_RULES['order.place'] as { limit: number; windowMs: number }
    for (let i = 0; i < rule.limit; i += 1) await consumeRate(db, 'order.place', subject, T0)
    assert.equal((await consumeRate(db, 'order.place', subject, T0)).allowed, false)

    const next = windowStartMs(T0, rule.windowMs) + rule.windowMs
    const fresh = await consumeRate(db, 'order.place', subject, next)
    assert.equal(fresh.allowed, true)
    assert.equal(fresh.remaining, rule.limit - 1)
  })

  test('lets a customer cancel far more often than they can order', () => {
    const place = RATE_RULES['order.place'] as { limit: number; windowMs: number }
    const cancel = RATE_RULES['order.cancel'] as { limit: number; windowMs: number }
    const perSecond = (rule: { limit: number; windowMs: number }): number =>
      rule.limit / (rule.windowMs / 1_000)
    assert.ok(
      perSecond(cancel) > perSecond(place),
      'cancellation must be looser than placement, or the exchange is easier to enter than to leave',
    )
  })
})

describe('enforcement', { skip }, () => {
  test('throws with a retry-after a client can honour', async () => {
    const subject = freshKey('user')
    const rule = RATE_RULES['order.place'] as { limit: number; windowMs: number }
    for (let i = 0; i < rule.limit; i += 1) await enforceRate(db, 'order.place', subject, T0)

    // One second into the window, so the honest wait is the rest of it. Rounded UP and floored at
    // one, because a `retry-after: 0` invites the client straight back into the refusal.
    const at = windowStartMs(T0, rule.windowMs) + 1_000
    await assert.rejects(
      () => enforceRate(db, 'order.place', subject, at),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitedError)
        assert.equal(err.action, 'order.place')
        assert.equal(err.limit, rule.limit)
        assert.equal(err.retryAfterSeconds, (rule.windowMs - 1_000) / 1_000)
        return true
      },
    )
  })

  test('never advises a wait of zero seconds', async () => {
    const subject = freshKey('user')
    const rule = RATE_RULES['order.place'] as { limit: number; windowMs: number }
    for (let i = 0; i < rule.limit; i += 1) await enforceRate(db, 'order.place', subject, T0)

    const lastInstant = windowStartMs(T0, rule.windowMs) + rule.windowMs - 1
    await assert.rejects(
      () => enforceRate(db, 'order.place', subject, lastInstant),
      (err: unknown) => err instanceof RateLimitedError && err.retryAfterSeconds === 1,
    )
  })
})

describe('the reaper', { skip }, () => {
  test('deletes closed windows and leaves the open one alone', async () => {
    const subject = freshKey('user')
    await consumeRate(db, 'order.place', subject, T0 - 60 * 60_000)
    await consumeRate(db, 'order.place', subject, T0)

    const deleted = await reapRateLimits(db, T0)
    assert.equal(deleted, 1)
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from rate_limits`
    assert.equal(rows[0]?.n, 1)
  })

  test('keeps a window that has only just closed, because a request may still be counting into it', async () => {
    const subject = freshKey('user')
    // A minute old: the widest rule's window is a minute, so this row may still be the live one for
    // some action. The grace is time-based rather than rule-based so that changing a rule cannot
    // make the reaper start deleting live counters without a migration to notice.
    await consumeRate(db, 'order.place', subject, T0 - 60_000)
    assert.equal(await reapRateLimits(db, T0), 0)
  })

  test('takes a bounded bite, so a reaper that has been broken for a week does not lock the table', async () => {
    assert.ok(REAP_BATCH > 0)
    const old = new Date(T0 - 60 * 60_000)
    const rows = Array.from({ length: 5 }, (_unused, i) => ({
      bucket: `market.read:filler-${i}`,
      window_start: old,
      count: 1,
    }))
    await sql`insert into rate_limits ${sql(rows)}`
    assert.equal(await reapRateLimits(db, T0), 5)
    assert.equal(await reapRateLimits(db, T0), 0)
  })
})
