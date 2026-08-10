/**
 * Rate limits, counted in the database rather than in a process.
 *
 * ## Why not a Map in memory
 *
 * Because there are two replicas behind the load balancer, and a per-process counter silently
 * doubles every limit the moment the service scales — at exactly the moment the limit matters. It
 * also resets on every deploy, which turns a rolling restart into an open window. A counter that
 * lies about its own value under the only conditions it exists for is not a rate limit.
 *
 * The cost is one round trip per limited request. That is a single-row upsert on a primary key, and
 * it is measured against the alternative: an order placement already takes a market row lock and
 * runs a matching pass, so the limit check is not the expensive part of the request it protects.
 *
 * ## Fixed windows, and their known flaw
 *
 * A fixed window admits up to twice the limit across a window boundary — the last instant of one
 * window and the first of the next. A sliding window fixes that and needs either a sorted set per
 * subject or two counters and an interpolation. The flaw is stated rather than hidden because it is
 * the right trade here: these limits exist to stop a runaway client and a scripted flood, and both
 * of those are two orders of magnitude over the limit rather than two times it.
 *
 * ## What a bucket is
 *
 * `<action>:<subject>` — the ACTION first, so a scan of the table by prefix answers "who is hammering
 * order placement" without a second index. The subject is the authenticated user id wherever there
 * is one, because limiting by IP behind a load balancer limits the load balancer.
 */

import type { Db } from './outbox.ts'

export interface RateRule {
  /** Requests permitted per window. */
  readonly limit: number
  readonly windowMs: number
}

/**
 * The limits, per action.
 *
 * Placement is the expensive one and the one an error loop hits hardest, so it is the tightest per
 * second; cancellation is deliberately LOOSER than placement, because the one thing a customer must
 * always be able to do in a hurry is get out. A rate limit that makes cancelling harder than
 * ordering is a rate limit that costs people money.
 */
export const RATE_RULES: Readonly<Record<string, RateRule>> = Object.freeze({
  'order.place': { limit: 60, windowMs: 10_000 },
  'order.cancel': { limit: 200, windowMs: 10_000 },
  'transfer.create': { limit: 20, windowMs: 60_000 },
  'market.read': { limit: 600, windowMs: 10_000 },
})

export type RateAction = keyof typeof RATE_RULES

export class RateLimitedError extends Error {
  readonly action: string
  readonly limit: number
  readonly retryAfterSeconds: number
  constructor(action: string, limit: number, retryAfterSeconds: number) {
    super(`rate limit exceeded for ${action}: ${limit} per window`)
    this.name = 'RateLimitedError'
    this.action = action
    this.limit = limit
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface RateVerdict {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  readonly resetAtMs: number
}

/** The start of the window `nowMs` falls in. Aligned to the epoch so every replica agrees. */
export function windowStartMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs
}

/**
 * Count one request against a bucket and say whether it is allowed.
 *
 * The insert-or-increment is a single statement, so two replicas racing produce two increments and
 * never one. It counts the request that is refused as well as the ones that are served, which is
 * intentional: a client in a retry loop should not be able to keep its own counter down by being
 * refused.
 *
 * Runs on `sql` and not on a caller's transaction. If it ran inside the placement transaction, a
 * rollback would give the refused request its quota back — and the request most likely to roll back
 * is the malformed one being retried in a loop.
 */
export async function consumeRate(
  sql: Db,
  action: RateAction,
  subject: string,
  nowMs: number,
): Promise<RateVerdict> {
  const rule = RATE_RULES[action] as RateRule
  const bucket = `${action}:${subject}`
  const start = windowStartMs(nowMs, rule.windowMs)
  const rows = await sql<{ count: number }[]>`
    insert into rate_limits (bucket, window_start, count)
    values (${bucket}, ${new Date(start)}, 1)
    on conflict (bucket, window_start) do update set count = rate_limits.count + 1
    returning count
  `
  const used = Number(rows[0]?.count ?? 1)
  const resetAtMs = start + rule.windowMs
  return {
    allowed: used <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - used),
    resetAtMs,
  }
}

/** Consume, and throw the refusal rather than returning it. The shape most call sites want. */
export async function enforceRate(
  sql: Db,
  action: RateAction,
  subject: string,
  nowMs: number,
): Promise<RateVerdict> {
  const verdict = await consumeRate(sql, action, subject, nowMs)
  if (!verdict.allowed) {
    throw new RateLimitedError(
      action,
      verdict.limit,
      Math.max(1, Math.ceil((verdict.resetAtMs - nowMs) / 1_000)),
    )
  }
  return verdict
}

/**
 * Delete windows that have closed.
 *
 * Without this the table grows by one row per bucket per window for ever, and the index that makes
 * the upsert cheap becomes the reason the table cannot be vacuumed. Run as a leased job — see
 * `RATE_REAP_KIND` in `src/jobs.ts`. The contended resource is the whole table rather than any one
 * bucket, so there is exactly one of these and it is keyed the way every other singleton in that
 * file is keyed.
 *
 * Batched, because a DELETE that takes the whole backlog in one statement holds a lock proportional
 * to how long the reaper has been broken — which is exactly when it can least afford to.
 */
export const REAP_BATCH = 10_000

export async function reapRateLimits(sql: Db, nowMs: number): Promise<number> {
  // Two windows of grace: the widest rule is a minute, and a row belonging to the window that is
  // still open must survive. Deleting by time rather than by rule keeps this correct when a rule
  // changes without a migration.
  const cutoff = new Date(nowMs - 5 * 60_000)
  const rows = await sql<{ bucket: string }[]>`
    delete from rate_limits
     where ctid in (
       select ctid from rate_limits where window_start < ${cutoff} limit ${REAP_BATCH}
     )
    returning bucket
  `
  return rows.length
}
