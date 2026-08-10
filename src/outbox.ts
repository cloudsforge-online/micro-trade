/**
 * Outbox, relay and inbox.
 *
 * Rule 5 of docs/ecosystem/03 §2: every state change others care about writes an outbox row **in
 * the same transaction as the change**. That single word is the whole design. A publish after
 * commit is a publish that is skipped when the process dies in between, and a publish before
 * commit is a publish of something that never happened; both failure modes are silent and both
 * are unrecoverable after the fact. Writing the event with the change makes the outbox row and
 * the domain row succeed or fail together, and turns delivery into a retry problem, which is a
 * problem with a solution.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won. Consumers
 * dedupe on `(topic, event_id)` — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`, and AD-10 records the four
 * measured conditions under which that stops being true.
 */

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  serviceActor,
  signDelivery,
  verifyDelivery,
  type EventVersion,
} from '@cloudsforge/contracts-events'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'

export type Db = Sql
export type Tx = TransactionSql

/** What a caller emits. The envelope's `id`, `occurredAt` and `producer` are added here. */
export interface DomainEvent {
  /** `<service>.<aggregate>.<past-tense-verb>` — `widget.widget.created`. */
  readonly topic: string
  /** Ordering is per `(topic, key)` only. Choose the aggregate id, never a timestamp. */
  readonly key: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly correlationId?: string
  readonly version?: number
}

/**
 * The wire version, in the CONTRACT's shape.
 *
 * `@cloudsforge/contracts-events` types `EventEnvelope.version` as `${number}.${number}` — a
 * "major.minor" STRING — and its consumers refuse an envelope without one ("version: missing").
 * Every producer typed it `number` end to end and sent `1`, so even a delivery whose signature
 * verified was refused at the envelope. The stored column stays an integer — storage records the
 * major — and the mapping to the contract's shape happens here, at the wire, in one place.
 *
 * The return type is now the contract's own `EventVersion`, IMPORTED rather than restated. A local
 * copy of a contract type is a copy that can drift, which is the whole reason this function exists.
 */
const wireVersion = (v: number): EventVersion => `${v}.0` as EventVersion

/**
 * The wire envelope. Additive-only, versioned per topic, schema-diff enforced — AD-02.
 *
 * **`actor` and `correlationId` are `string`, not `string | null`.** They used to be nullable here
 * because the columns are nullable, and that was the same defect as the integer version wearing a
 * third hat: `validateEnvelope` refuses a null actor ("actor: missing") and a null correlation id
 * ("correlationId: missing; a cross-service investigation stops here"). A nullable column is a
 * storage fact; the wire has no such freedom, and `buildEnvelope` is where the two meet.
 */
export interface EventEnvelope {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurredAt: string
  readonly producer: string
  readonly version: EventVersion
  readonly actor: string
  readonly correlationId: string
  readonly payload: Record<string, unknown>
}

export type Emit = (event: DomainEvent) => void

/**
 * Run a domain change and its events in one transaction.
 *
 *   const widget = await withOutbox(sql, SERVICE, async (tx, emit) => {
 *     const row = await insertWidget(tx, input)
 *     emit({ topic: 'widget.widget.created', key: row.id, payload: { id: row.id } })
 *     return row
 *   })
 *
 * `emit` collects rather than writes, so the events land after the handler has succeeded and a
 * caller cannot accidentally publish an event for a change it then rolled back.
 */
export async function withOutbox<T>(
  sql: Db,
  producer: string,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
): Promise<T> {
  const outcome = await sql.begin(async (tx) => {
    const pending: DomainEvent[] = []
    const value = await fn(tx, (event) => {
      pending.push(event)
    })
    await flushEvents(tx, producer, pending)
    // Wrapped so postgres.js does not treat an array-shaped result as a list of promises to
    // unwrap, which would rewrite the caller's return type.
    return { value }
  })
  return outcome.value
}

/**
 * Write collected events into the outbox on a transaction the caller owns.
 *
 * Exported because `withIdempotency` needs the same thing and cannot nest a second `withOutbox`
 * inside its own transaction: the claim and the work have to commit together, so there is only one
 * transaction to write into. Sharing the statement rather than copying it is what stops the two
 * paths drifting on the columns or on the `version ?? 1` default — a drifted version column is the
 * exact defect `src/topics.ts` was written about.
 */
export async function flushEvents(tx: Tx, producer: string, events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) {
    await tx`
      insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
      values (
        ${event.topic},
        ${event.key},
        ${producer},
        ${event.version ?? 1},
        ${event.actor ?? null},
        ${event.correlationId ?? null},
        ${tx.json(event.payload as Record<string, never>)}
      )
    `
  }
}

/* ------------------------------------------------------------------------ signing */


/** `sha256=<hex>` over the exact bytes sent, so a subscriber verifies before parsing. */
/**
 * THE CONTRACT SIGNS, NOT THIS FILE. This used to be a local implementation — `sha256=<hmac over
 * the body>` under a locally-declared header name — and four other producers carried the same
 * copy. The contract (`@cloudsforge/contracts-events`) signs `t=<seconds>,v1=<hmac over
 * "<seconds>.<body>">` under `cf-signature`, and the consumers that import it (activity, notify)
 * verify exactly that: every delivery from every producer was refused, first as
 * "signature: missing" and, once the header name was aligned, as "malformed_header". Two drifted
 * copies of one contract value, found the first time the bus was composed for real.
 *
 * The exported names stay, so no call site or test changes; the implementations are the
 * contract's, so they cannot drift again.
 */
export function signEvent(body: string, secret: string): string {
  return signDelivery(body, secret)
}

/**
 * Timing-safety and the freshness window both live in the contract's verifier.
 *
 * `secrets` may be a LIST, and the candidates are handed straight to `verifyDelivery` rather than
 * looped over here. That is the point: the contract tries each with `timingSafeEqual`, and a
 * byte-at-a-time comparison of a MAC is a byte-at-a-time forgery oracle. Looping in this file would
 * also re-derive the freshness window per candidate. A list is what gives a rotation of the
 * estate's shared signing secret an overlap window instead of a flag day.
 */
export function verifyEventSignature(
  body: string,
  secrets: string | readonly string[],
  presented: string,
): boolean {
  return verifyDelivery(body, presented, secrets).ok
}

/* ------------------------------------------------------------------------ relay */

export interface RelayDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly signingSecret: string
  readonly batchSize?: number
  readonly deadlineMs?: number
  /** Test seam. Production builds one `HttpClient` per subscription URL. */
  readonly clientFor?: (url: string) => Pick<HttpClient, 'request'>
}

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

interface SubscriptionRow {
  readonly id: string
  readonly url: string
}

/**
 * One outbox row → one wire envelope. **The only place an envelope is built.**
 *
 * Exported so `topics.test.ts` can hand the real thing to the contract's own `validateEnvelope`
 * rather than to a copy. That distinction is the point: every service's suite was green while
 * every event it emitted was refused, because both sides tested against imagined counterparts. A
 * guard that builds its own envelope proves only that the guard can build an envelope.
 *
 * The two defaults are the contract's own semantics, not inventions:
 *
 *   - **`correlationId` falls back to the event id.** `makeEvent` does exactly this — "an event
 *     that starts a story rather than continuing one is its own correlation root". A null here
 *     would be refused outright, and refusing an event because nobody handed it a request id
 *     would lose the event rather than the trace.
 *   - **`actor` falls back to `service:trade`.** An emit with no actor was this service acting on
 *     its own behalf — the bot tick, the fee settlement job — and that is precisely what
 *     `serviceActor` spells. `null` is not an actor the contract has a word for.
 */
export function buildEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.id,
    topic: row.topic,
    key: row.key,
    occurredAt: row.occurred_at.toISOString(),
    producer: row.producer,
    version: wireVersion(row.version),
    actor: row.actor ?? serviceActor('trade'),
    correlationId: row.correlation_id ?? row.id,
    payload: row.payload,
  }
}

/**
 * The relay job.
 *
 * A leased job rather than a `setInterval`, for the reason rule 8 exists: two replicas running an
 * interval-driven relay both read the same unpublished rows and every subscriber receives every
 * event twice. The lease key names the contended resource — the outbox stream — so exactly one
 * replica relays at a time whatever the replica count is.
 */
export function createRelay(deps: RelayDeps): Handler {
  const batchSize = deps.batchSize ?? 50
  const deadlineMs = deps.deadlineMs ?? 5_000
  // Clients are cached for the life of the process so a circuit breaker accumulates state across
  // ticks. A fresh client per tick has a permanently closed circuit and hammers a dead subscriber.
  const clients = new Map<string, Pick<HttpClient, 'request'>>()
  const clientFor =
    deps.clientFor ??
    ((url: string) => {
      const existing = clients.get(url)
      if (existing) return existing
      const parsed = new URL(url)
      const client = new HttpClient({ baseUrl: parsed.origin, name: `subscriber:${parsed.host}` })
      clients.set(url, client)
      return client
    })

  return async (_job, ctx) => {
    const events = await deps.sql<OutboxRow[]>`
      select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
        from outbox
       where published_at is null
       order by occurred_at
       limit ${batchSize}
    `

    for (const event of events) {
      if (ctx.signal.aborted) return

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      const envelope = buildEnvelope(event)
      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signEvent(JSON.stringify(envelope), deps.signingSecret)

      for (const subscription of subscriptions) {
        await deliver(deps, clientFor, subscription, envelope, signature, deadlineMs)
      }

      // Only when nothing is outstanding.
      //
      // THE GUARANTEE THIS USED TO CLAIM IS FALSE, and it was carried verbatim by eighteen
      // repositories. It said "a subscriber added after the event was written still receives it",
      // which holds only while some OTHER subscriber is still undelivered. With no active
      // subscription for the topic — the ordinary case for a new event type — the count below is
      // zero on the first pass, the row is published immediately, and it is never reconsidered. A
      // subscriber added afterwards gets nothing.
      //
      // The behaviour is right: an outbox row that stays unpublished because nobody is listening
      // is a backlog that grows for ever. It is the promise that was wrong, and a false guarantee
      // is worse than none, because an integrator plans around it — "register the subscription
      // whenever, the outbox will catch up" is a reasonable thing to believe from the old wording
      // and will silently lose every event published before the subscription existed.
      //
      // Delivery rows ARE computed from the live subscription set on every pass, which is what
      // makes a subscriber added mid-flight receive the remainder. That is the true half.
      const outstanding = await deps.sql<{ n: number }[]>`
        select count(*)::int as n
          from event_subscriptions s
          left join outbox_deliveries d
            on d.subscription_id = s.id and d.event_id = ${event.id}
         where s.topic = ${event.topic}
           and s.active = true
           and d.delivered_at is null
      `
      if ((outstanding[0]?.n ?? 0) === 0) {
        await deps.sql`update outbox set published_at = now() where id = ${event.id}`
      }

      // A long backlog must not outlive the lease and hand the same events to a second replica.
      await ctx.heartbeat()
    }
  }
}

async function deliver(
  deps: RelayDeps,
  clientFor: (url: string) => Pick<HttpClient, 'request'>,
  subscription: SubscriptionRow,
  envelope: EventEnvelope,
  signature: string,
  deadlineMs: number,
): Promise<boolean> {
  const claimed = await deps.sql<{ delivered_at: Date | null }[]>`
    insert into outbox_deliveries (event_id, subscription_id, attempts)
    values (${envelope.id}, ${subscription.id}, 0)
    on conflict (event_id, subscription_id) do update set attempts = outbox_deliveries.attempts + 1
    returning delivered_at
  `
  if (claimed[0]?.delivered_at) return true

  const parsed = new URL(subscription.url)
  try {
    await clientFor(subscription.url).request(`${parsed.pathname}${parsed.search}`, {
      method: 'POST',
      body: envelope,
      deadlineMs,
      // The event id is the idempotency key, which is what makes this POST safe to retry and is
      // the same value the subscriber dedupes on.
      idempotencyKey: envelope.id,
      headers: { [SIGNATURE_HEADER]: signature, [EVENT_ID_HEADER]: envelope.id },
      ...(envelope.correlationId ? { requestId: envelope.correlationId } : {}),
    })
    await deps.sql`
      update outbox_deliveries set delivered_at = now(), last_error = null
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.sql`
      update outbox_deliveries set last_error = ${message.slice(0, 2_000)}
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    // Logged, not thrown: one unreachable subscriber must not stop the other subscribers or the
    // rest of the batch. The job succeeds; the undelivered row is the durable record, and the
    // next pass retries it.
    deps.logger.warn('event delivery failed', {
      topic: envelope.topic,
      eventId: envelope.id,
      subscriptionId: subscription.id,
      err: message,
    })
    return false
  }
}

/* ------------------------------------------------------------------------ inbox */

export type InboxOutcome<T> = { readonly status: 'processed'; readonly value: T } | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * The insert and the handler share one transaction, so a handler that fails leaves no inbox row
 * and the redelivery is processed rather than swallowed — which is the mistake that makes a naive
 * "record then handle" dedupe lose events.
 */
export async function withInbox<T>(
  sql: Db,
  topic: string,
  eventId: string,
  handle: (tx: Tx) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}

export { EVENT_ID_HEADER, SIGNATURE_HEADER }
