/**
 * Run a mutating operation at most once per key.
 *
 * **Taken from `micro-ledger/src/idempotency.ts`, which took it from
 * `repos/forge-pay/services/pay/src/store.ts`.** Two changes, both mechanical: the claim row
 * points at a urn rather than a `journal_entries` id, because what this service creates is a bot, a
 * fill or a settlement rather than an entry; and there is no foreign key, because the claim
 * deliberately outlives some of what it names.
 *
 * Nothing about the ALGORITHM is changed, and it must not be. What it gets right, preserved in
 * full:
 *
 *   1. **The claim INSERT and the work share ONE transaction.** The stored response can therefore
 *      never disagree with what actually committed. A design that claims the key in its own
 *      transaction and then does the work has a window in which the key exists and the postings do
 *      not — and a retry arriving in that window is answered "already done" for work that never
 *      happened.
 *   2. **A concurrent duplicate blocks rather than races.** The second INSERT waits on the first
 *      transaction's uncommitted row; when that commits, the duplicate reads the stored response
 *      and replays it. A retry can therefore never double-debit or double-credit.
 *   3. **A reused key with a different body is refused, not replayed.** Returning the first
 *      request's answer to a second, different request is worse than an error: the caller believes
 *      the thing it asked for happened.
 *   4. **A claim with no response yet is "in flight", not "done".** If the original transaction
 *      rolled back between the insert and this read, nothing committed, so the honest answer is
 *      "retry" rather than a guess.
 *
 * What is added: the key is namespaced by the calling service. Keys are chosen by callers, and two
 * services independently choosing `settle-2024-11-03` must not collide — under one flat namespace
 * the second service's entry would be silently swallowed as a replay of the first's.
 *
 * Any constraint that fires at COMMIT — `fills_bot_bar_side_uniq`, `fee_settlements_bot_period_uniq`
 * — takes the claim row with it, so a refused write never leaves a key behind that would make its
 * retry a no-op.
 */

import { createHash } from 'node:crypto'
import { flushEvents, type DomainEvent, type Db, type Emit, type Tx } from './outbox.ts'

/** The claim exists but its transaction has not committed a response yet. The caller retries. */
export class IdempotencyInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight; retry shortly')
    this.name = 'IdempotencyInFlightError'
  }
}

/** The same key was presented with a different body. 409, always. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('this idempotency key was already used with a different request body')
    this.name = 'IdempotencyKeyReuseError'
  }
}

/**
 * A stable fingerprint of a request body, so a reused key with a changed payload is caught.
 *
 * Keys are sorted at every depth before hashing. `JSON.stringify` preserves insertion order, so
 * two semantically identical bodies that serialised their fields in a different order would
 * fingerprint differently and a legitimate retry would be rejected as reuse. Sorting removes a
 * class of false 409 that would be maddening to diagnose from the caller's side.
 */
/**
 * Fields that legitimately differ between attempts at the *same* operation, and are therefore
 * excluded from the fingerprint.
 *
 * `correlationId` is the sharp one. It is a trace identifier and it is *supposed* to change on
 * every attempt — that is what makes a retry distinguishable from the original in a trace. But
 * including it in the fingerprint means a caller doing exactly the right thing, retrying with a
 * fresh request id, is told its idempotency key was reused with a different payload. The retry
 * then fails with 409 and the caller cannot tell a genuine key collision from its own tracing.
 *
 * Found by `micro-wallet`, which had to carry a correlation id that was stable per operation
 * rather than per attempt in order to work around this. That workaround should not have been
 * necessary and is not, now.
 */
const PER_ATTEMPT_FIELDS = new Set(['correlationId'])

export function requestFingerprint(value: unknown): string {
  const subject =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => !PER_ATTEMPT_FIELDS.has(key),
          ),
        )
      : value
  return createHash('sha256').update(canonicalise(subject)).digest('hex')
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}

/**
 * The stored key, namespaced by the calling service.
 *
 * Keys are chosen by callers, and two callers independently choosing `start-1` must not collide —
 * under one flat namespace the second caller's request would be silently swallowed as a replay of
 * the first's.
 */
export function namespacedKey(originatingService: string, route: string, clientKey: string): string {
  return `${originatingService}:${route}:${clientKey}`
}

export interface IdempotentOutcome<T> {
  readonly result: T
  readonly replayed: boolean
}

export interface IdempotencyInput<T> {
  readonly originatingService: string
  readonly route: string
  readonly clientKey: string
  readonly requestHash: string
  /**
   * The work. Returns the response to store and, when the work created one, a urn naming what it
   * created — so the claim row points at the bot, fill or settlement and an operator can join a
   * key to the thing it produced.
   *
   * `emit` is the outbox, on this same transaction. It exists because the alternative — wrapping the
   * work in `withOutbox` — opens a SECOND transaction inside this one, and then the claim and the
   * events can commit apart: an event announcing an order that the claim rolled back, or a claim
   * whose event never went. One transaction is the entire argument of this file, and the events
   * belong inside it.
   */
  readonly run: (tx: Tx, storedKey: string, emit: Emit) => Promise<{ response: T; subjectUrn: string | null }>
}

export async function withIdempotency<T>(sql: Db, input: IdempotencyInput<T>): Promise<IdempotentOutcome<T>> {
  const key = namespacedKey(input.originatingService, input.route, input.clientKey)

  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ key: string }[]>`
      insert into idempotency_keys (key, route, request_hash)
      values (${key}, ${input.route}, ${input.requestHash})
      on conflict (key) do nothing
      returning key
    `

    if (claimed.length === 0) {
      // Someone else holds the key. By the time this read runs, their transaction has either
      // committed (so the response is here) or rolled back (so the row is gone).
      const rows = await tx<{ request_hash: string; response: unknown }[]>`
        select request_hash, response from idempotency_keys where key = ${key}
      `
      const existing = rows[0]
      if (!existing) throw new IdempotencyInFlightError()
      if (existing.request_hash !== input.requestHash) throw new IdempotencyKeyReuseError()
      if (existing.response === null || existing.response === undefined) {
        throw new IdempotencyInFlightError()
      }
      return { value: { result: existing.response as T, replayed: true } }
    }

    const pending: DomainEvent[] = []
    const { response, subjectUrn } = await input.run(tx, key, (event) => {
      pending.push(event)
    })
    // After the work and before the response is stored, so an event can only exist for work that is
    // about to be answered for. `originatingService` is the producer by definition here: it is the
    // service whose route is running.
    await flushEvents(tx, input.originatingService, pending)

    await tx`
      update idempotency_keys
         set response = ${tx.json(response as Record<string, never>)},
             subject_urn = ${subjectUrn}
       where key = ${key}
    `

    return { value: { result: response, replayed: false } }
  })

  // Wrapped in an object above so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/**
 * How many keys one DELETE claims.
 *
 * An unbounded DELETE over a table that has never been pruned is a single long transaction holding
 * a row lock on everything it removes, producing one enormous batch of dead tuples. Short
 * statements let autovacuum keep up and keep the reaper out of the way of the claim INSERT at the
 * head of every posting request.
 */
const REAP_BATCH = 5_000

/**
 * Delete idempotency keys past their TTL. Returns how many rows went.
 *
 * The cutoff is the entire safety argument: expiring a key EARLY means the next replay of it does
 * the work a second time, so the TTL has to outlive every caller's retry horizon rather than be as
 * short as the table would like.
 *
 * A claim row that produced something is kept regardless of age. The row is the only link between a
 * caller's key and the fill or settlement it produced, and losing it turns "did my retry trade
 * twice" into an unanswerable question.
 */
export async function reapIdempotencyKeys(sql: Db, ttlDays: number): Promise<number> {
  // An ISO string with an explicit cast, not a Date: postgres.js resolves a prepared statement's
  // parameter types from the server's ParameterDescription, and inside a subquery it does not come
  // back with the timestamptz serialiser — a raw Date is then handed to the text encoder and
  // throws. The cast removes the question. The string is UTC, which is what the column stores.
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  let total = 0
  for (;;) {
    const result = await sql`
      delete from idempotency_keys
       where key in (
         select key from idempotency_keys
          where created_at < ${cutoff}::timestamptz
            and subject_urn is null
          limit ${REAP_BATCH}
       )
    `
    total += result.count
    if (result.count < REAP_BATCH) return total
  }
}
