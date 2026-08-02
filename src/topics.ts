/**
 * The producer half of the bus contract: what this service puts on the wire, and whether the
 * estate can read it.
 *
 * ## The defect this file exists to close
 *
 * Every consumer in the estate is pinned to `@cloudsforge/contracts-events`. `activity` declares
 * its classifier table `satisfies Readonly<Record<TopicName, _>>`; `notify` asserts it has a rule
 * for every registry topic. **The producer was pinned to nothing at all** — not to the topic names
 * and, worse, not to the shape of the envelope it wrote them into.
 *
 * Two instances of that one class have already cost the estate every event it ever relayed:
 *
 *   - **A version stamped wrong.** `EventEnvelope.version` is `` `${number}.${number}` `` in the
 *     contract — a "major.minor" STRING. Six producers typed it `number` end to end and sent `1`,
 *     and `validateEnvelope` refuses that with "version: missing". The signature verified, the
 *     delivery arrived, and the consumer threw it away at the envelope before anything looked at
 *     a payload. Each service's own suite stayed green throughout, because each tested against
 *     its own fake of the other side.
 *   - **A topic renamed on the wire.** `wallet` emitted `wallet.deposit.credited` while the
 *     registry, `notify` and `activity` all spell it `wallet.deposit.confirmed`. Nothing could
 *     ever match it.
 *
 * These are the same defect wearing two hats: **the producer is free and the consumer is pinned.**
 * So this file pins the producer, in both directions and two ways:
 *
 *   1. **At compile time.** `EventEnvelope.version` in `outbox.ts` is the contract's
 *      `EventVersion`, imported rather than restated. Assigning the stored integer to it is a type
 *      error, which is `pnpm typecheck`, which is the build.
 *   2. **At test time, against the source rather than against this list.** `topics.test.ts` reads
 *      every topic literal out of `src/` and reconciles that set with the registry, and it builds
 *      a real envelope through the relay's own `buildEnvelope` and hands it to the contract's own
 *      `validateEnvelope`.
 *
 * ## Nothing this service emits is registered, and that is the thing to fix next
 *
 * `trade` IS a valid `ProducerService` in the contract's union and owns **zero** topics in
 * `TOPICS`. Every one of the five below therefore sits in the quarantine, each carrying the exact
 * `TopicSpec` `micro-contracts` should paste. That is not a defect of this repository — the
 * contract package is not this one's to change — but it is the reason `activity` files every trade
 * event as `unclassified`: a bot a user started, a fill they were charged for, and a performance
 * fee taken from their account are all quarantined as events nobody has named.
 */

import {
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
  validateEnvelope,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'

/** This service's own name, and the namespace it is the only permitted producer under. */
export const SERVICE = 'trade'

/**
 * Every topic this service emits.
 *
 * `topics.test.ts` reads the literals back out of `src/` and asserts this list equals them, in
 * both directions — so it cannot name a topic no emit site produces, and an emit site cannot
 * produce a topic this list has never heard of.
 */
export const EMITTED_TOPICS = Object.freeze([
  'trade.bot.created',
  'trade.bot.paused',
  'trade.bot.started',
  'trade.fee.settled',
  'trade.fill.settled',
] as const)

export interface ProposedTopic {
  /** Why the fact belongs on the bus at all. Read by a human reviewing the contracts change. */
  readonly reason: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Topics this service emits that the shared registry does not yet name.
 *
 * A quarantine, not an exemption, with the three properties that keep identity's honest:
 *
 *   - An entry carries the exact `TopicSpec` it is asking for, so adopting it into
 *     `contracts/packages/events/src/index.ts` is a copy rather than a fresh design.
 *   - `topics.test.ts` asserts every entry is **genuinely absent** from the registry. The moment
 *     contracts registers one, this file fails until the entry is deleted — so the quarantine
 *     empties itself rather than rotting into a permanent allow-list.
 *   - An emit site whose topic is in neither the registry nor here fails the test.
 *
 * `keyedBy` on each is read off the emit site, never chosen here: the key is the ordering
 * partition, so it is contract rather than a producer's private preference.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({
  'trade.bot.created': {
    reason:
      "A user configured an automated strategy against their own money. activity's timeline has no entry for it and notify has no rule, because no registry names it.",
    spec: {
      producer: 'trade',
      payloadType: 'BotCreated',
      version: '1.0',
      keyedBy: 'bot_id',
      description: 'A trading bot was configured, with its mode, strategy and allocation.',
    },
  },
  'trade.bot.started': {
    reason:
      'The moment money starts moving on its own. It carries the ledger reservation id, which is the only thing a consumer can reconcile the allocation against.',
    spec: {
      producer: 'trade',
      payloadType: 'BotStarted',
      version: '1.0',
      keyedBy: 'bot_id',
      description: 'A bot began trading and its allocation was reserved through the ledger.',
    },
  },
  'trade.bot.paused': {
    reason:
      'The other half of started. Without it a consumer that saw a bot start believes it is still trading for ever.',
    spec: {
      producer: 'trade',
      payloadType: 'BotPaused',
      version: '1.0',
      keyedBy: 'bot_id',
      description: 'A bot stopped trading.',
    },
  },
  'trade.fill.settled': {
    reason:
      'Keyed by FILL id, not bot id, and that difference is real: two fills for one bot have no ordering relationship to each other and pretending otherwise would serialise a bot behind its own history.',
    spec: {
      producer: 'trade',
      payloadType: 'FillSettled',
      version: '1.0',
      keyedBy: 'fill_id',
      description: 'A bot fill settled against the ledger, with its journal entry.',
    },
  },
  'trade.fee.settled': {
    reason:
      "A performance fee was taken from a user's account. 10.5's `bot.settle` lease exists to stop this being double-billed; a consumer cannot check that today because the fact never reaches one.",
    spec: {
      producer: 'trade',
      payloadType: 'FeeSettled',
      version: '1.0',
      keyedBy: 'settlement_id',
      description: 'A performance fee settlement completed for a bot period, with its entry.',
    },
  },
})

/* ------------------------------------------------------------------ reconciliation */

/** Topics this service emits that no registry names and no proposal explains — always a defect. */
export function undeclaredTopics(emitted: readonly string[]): readonly string[] {
  return emitted
    .filter((topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic))
    .sort()
}

/**
 * Registry topics this service owns and never emits — a feature that can never fire.
 *
 * The direction that is easiest to miss, because nothing breaks and nothing logs: consumers
 * classify the topic, the code path renders it, and nothing ever arrives. Empty today only
 * because the registry owns no trade topic at all, which is the gap the quarantine describes.
 */
export function unemittedOwnedTopics(emitted: readonly string[]): readonly TopicName[] {
  const seen = new Set(emitted)
  return topicsProducedBy(SERVICE).filter((topic) => !seen.has(topic))
}

/** Proposals the registry has since adopted. Non-empty means delete the entry from the quarantine. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal that could not be pasted into the registry as it stands. */
export function malformedProposals(): readonly string[] {
  return Object.entries(AWAITING_REGISTRATION)
    .filter(([topic, proposal]) => {
      if (!isValidTopicName(topic) || !topic.startsWith(`${SERVICE}.`)) return true
      if (proposal.spec.producer !== SERVICE) return true
      if (proposal.spec.keyedBy.trim() === '') return true
      if (proposal.reason.trim().length < 20) return true
      return false
    })
    .map(([topic]) => topic)
    .sort()
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Every reason a contract-following consumer would refuse this envelope.
 *
 * `validateEnvelope` is the contract's own function and is the exact check that `activity` and
 * `notify` run on a delivered body. Running it here, on an envelope this service's relay actually
 * built, is the only way a producer finds out it is unreadable without waiting for two services to
 * be composed — which is how this was found the first time, months late.
 *
 * **One error is tolerated and only one:** "not in this registry", and only for a topic the
 * quarantine above explains. That is a consumer being behind its producers, which is a normal
 * consequence of deploying twenty-two services independently and which `activity` handles by
 * quarantining rather than dropping. Every other error — a version in the wrong shape, a missing
 * correlation id, an id that is not a UUID, a producer that does not own its topic — is this
 * service emitting something nobody can read, and is returned.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = validateEnvelope(envelope)
  if (verdict.ok) return []
  const topic =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>)['topic']
      : undefined
  const excused =
    typeof topic === 'string' && Object.hasOwn(AWAITING_REGISTRATION, topic)
      ? `topic: "${topic}" is not in this registry; contracts-events may be behind`
      : null
  return verdict.errors.filter((error) => error !== excused)
}
