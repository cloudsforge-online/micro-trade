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
 *      `classifyEnvelope`.
 *
 * ## All seven are registered, and the quarantine below is empty
 *
 * `trade` IS a valid `ProducerService` in the contract's union. It owned exactly one topic in
 * `TOPICS` — **`trade.bot.paused`**, adopted verbatim from the quarantine as of `micro-contracts`
 * `8889373` — and as of micro-org#345 it owns all seven: the other six were pasted into the
 * registry from the specs that used to sit below, and deleted from here the same day. That is the
 * whole cycle this table is for, run twice, and the deletion is not tidying: `adoptedProposals()`
 * fails while a registered topic is still proposed, so the quarantine empties itself or the suite
 * stays red.
 *
 * What it cost while it was full is worth keeping written down, because it was never the missing
 * timeline entries that mattered most. `activity` filed every trade event as `unclassified` —
 * a bot a user started, a fill they were charged for and a performance fee taken from their
 * account were all events nobody had named — which is 90-day quarantine retention on four topics
 * that move money, where a financial record gets 1825. And `activity`'s unregistered branch cannot
 * check what a `TopicSpec` is the only source of: an envelope claiming `producer: 'wallet'` on a
 * trade topic was shelved with no defect reported at all, because ownership is a property of the
 * registry entry that did not exist. Measured on 2026-08-10, before the registration:
 * `{ topic: 'trade.fee.settled', producer: 'wallet' }` classified as `unregistered_topic` with an
 * empty defect list, while the same forgery on `trade.bot.paused` came back `malformed`.
 *
 * `contracts/packages/events/src/audit.ts` committed, in its `trade.bot.paused` entry, to auditing
 * the money topics when they landed; `TOPIC_AUDIT` now carries all six decisions.
 *
 * `topics.test.ts` builds the envelope with this service's own relay and hands it to the contract's
 * own `classifyEnvelope`, which is the check that closes the gap on this side — and it is now a
 * check with seven topics to answer for rather than one.
 */

import {
  classifyEnvelope,
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
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
  'trade.order.filled',
  'trade.transfer.settled',
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
 *
 * ── EMPTY, AND THAT IS THE TABLE WORKING. micro-org#345, 2026-08-10. ──────────────────────────
 *
 * It held six entries until `micro-contracts` pasted all six into `TOPICS` verbatim — every field
 * of every spec, `keyedBy` included, went across unchanged, which is the property that makes this
 * a copy rather than a second design. `adoptedProposals()` turned non-empty the moment the
 * registry adopted them, this suite went red, and the entries are deleted rather than kept with a
 * note. The type stays `ProposedTopic` and the reconciliation below stays wired to it, because the
 * next topic this service adds arrives here first: an emit site whose topic is in neither the
 * registry nor this table fails `topics.test.ts`, and that check is the reason nothing was ever
 * emitted under a name the estate could not read.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({})

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
 * classify the topic, the code path renders it, and nothing ever arrives. It used to be empty
 * vacuously — the registry owned no trade topic at all, so there was nothing for it to find. Since
 * `trade.bot.paused` was registered it is a real check with one topic to answer for: delete or
 * rename `bots.ts` and this returns it, naming a consumer that would wait for ever.
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
 * The check itself is `classifyEnvelope`, and it is the contract's — the exact check `activity` and
 * `notify` run on a delivered body. Running it here, on an envelope this service's relay actually
 * built, is the only way a producer finds out it is unreadable without waiting for two services to
 * be composed, which is how this was found the first time, months late.
 *
 * ## Why this is now four lines and not sixteen
 *
 * It used to make the "malformed" / "not in this registry" distinction itself, by comparing against
 * the contract's exact error SENTENCE:
 *
 *     const excused = `topic: "${topic}" is not in this registry; contracts-events may be behind`
 *     return verdict.errors.filter((error) => error !== excused)
 *
 * `market`, `community` and `devplatform` each carried that byte for byte. **A prose message is not
 * an interface.** Reword it in `contracts-events` by one character and all four copies silently
 * stop excusing anything: every quarantined topic starts reading as a producer bug and four suites
 * go red for a reason unrelated to what they test. Nothing here tied the literal to its source.
 * `classifyEnvelope` carries the distinction as STRUCTURE — `unregisteredTopic` is a field, not a
 * sentence — so there is no longer a string that can drift.
 *
 * ## What this file still decides, and the contract cannot
 *
 * **Which** unregistered topics are excused: the ones `AWAITING_REGISTRATION` above proposes. A
 * consumer lagging its producers is normal when twenty-two services deploy independently, and
 * `activity` quarantines rather than drops. Everything else the contract found is returned — a
 * version in the wrong shape, a missing correlation id, an id that is not a UUID, a producer that
 * does not own its topic — because each of those is this service emitting the unreadable.
 *
 * ## Why not the contract's own `envelopeDefects(value, awaitingRegistration)`
 *
 * It ships beside `classifyEnvelope` and looks like a drop-in for this function. It is not, and the
 * difference is the one this whole exercise is about. It flattens the verdict back to `string[]`,
 * and in flattening it **drops `unregisteredTopic` whenever any other defect is present** — so an
 * envelope on a topic nobody proposed that is ALSO malformed reports only the malformation, the
 * author fixes it, re-runs, and only then learns about the topic. That contradicts the wrapper's
 * own package documentation ("an envelope can be both, and `malformed` still reports
 * `unregisteredTopic`, so a producer fixing it needs one round rather than two") and it is exactly
 * the collapse of two facts into one that let eleven `notify` rules name topics no producer emits.
 * `classifyEnvelope` itself is right; only the convenience wrapper loses the fact. So this reads the
 * structured verdict and keeps both. Reported to `micro-contracts`; the test named "an unproposed
 * topic AND a broken version are reported together" is what stops a future tidy-up from adopting
 * the wrapper and losing a fact while every other assertion here stays green.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = classifyEnvelope(envelope)
  // Reported FIRST, where `validateEnvelope` has always put it, so a reader of a failure sees the
  // registry question before the envelope's own faults.
  const unexplained =
    verdict.unregisteredTopic !== null &&
    !Object.hasOwn(AWAITING_REGISTRATION, verdict.unregisteredTopic)
      ? [`topic: "${verdict.unregisteredTopic}" is not in the registry, and AWAITING_REGISTRATION does not propose it`]
      : []
  return [...unexplained, ...verdict.defects]
}

