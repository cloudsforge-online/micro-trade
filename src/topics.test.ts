/**
 * The producer half of the bus contract, checked against the source rather than against a list.
 *
 * Two families of check, for the two shapes one defect class has already taken in this estate:
 *
 *   1. **The name.** `wallet` emitted `wallet.deposit.credited` for the life of the service while
 *      the registry, `notify` and `activity` all spelled it `wallet.deposit.confirmed`. Nothing
 *      could ever match it. Reconciling the emitted set with the registry in BOTH directions is
 *      what catches that, and reading the literals back out of `src/` is what stops the check
 *      agreeing with itself while the emit sites drift.
 *   2. **The envelope.** Six producers stamped `version` as the integer `1` where the contract
 *      types it `"major.minor"`, so `validateEnvelope` refused every event they ever relayed with
 *      "version: missing". Every suite in the estate was green throughout, because both sides
 *      tested against imagined counterparts. The only check that could have caught it is the one
 *      below: build an envelope with the relay's own `buildEnvelope` and hand it to the contract's
 *      own `classifyEnvelope`.
 *
 * NOTE that the registry now names ALL SEVEN `trade.*` topics — `trade.bot.paused` alone from
 * `micro-contracts` `8889373`, and the other six with micro-org#345 — so the quarantine is empty
 * and nothing in this file is excused any more. That matters to how these checks read: while six
 * were quarantined, the envelope check passed for them only because the quarantine forgave the
 * topic, and `envelopeDefects excuses a lagging registry and nothing else` existed to prove the
 * forgiveness stopped at the topic. It is now a check on a repository with nothing to forgive, and
 * says so rather than pretending otherwise.
 *
 * Registration is also what makes the third obligation reachable, and it is the reason
 * `every key these emit sites pass is the key the registry says they pass` exists.
 * `TopicSpec.keyedBy` is PROSE — a column name in a frozen object, not a type — so no compiler can
 * make an emit site pass what it names. `custody` registered both ceremony topics `keyedBy:
 * 'user_id'` while the emit sites passed the address, and `activity` reads the envelope key AS the
 * subject id, so every export was filed against a user that does not exist while every name check
 * in the estate stayed green. That check covered one topic when one was registered; it covers all
 * seven now, which is where four money topics with a second id in scope at the emit have arrived.
 *
 * No database. Pure text, set arithmetic and one function call, so it runs in CI even when the
 * database-backed suite skips.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SIGNATURE_HEADER,
  TOPICS,
  TOPIC_NAMES,
  isRegisteredTopic,
  parseVersion,
  topicsProducedBy,
  verifyDelivery,
  type TopicName,
} from '@cloudsforge/contracts-events'
import { buildEnvelope, signEvent, verifyEventSignature } from './outbox.ts'
import {
  AWAITING_REGISTRATION,
  EMITTED_TOPICS,
  SERVICE,
  adoptedProposals,
  envelopeDefects,
  malformedProposals,
  undeclaredTopics,
  unemittedOwnedTopics,
} from './topics.ts'

const SRC = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'testsupport.ts')
    .map((file) => join(SRC, file))
}

/**
 * The files a topic literal may legitimately appear in.
 *
 * `topics.ts` is excluded, and that exclusion is the whole check rather than a convenience: it is
 * the file holding `EMITTED_TOPICS` and the quarantine, and it is the thing being checked. Scanning
 * it would let a quarantine entry justify its own existence — a topic could be declared,
 * quarantined and never emitted, and every assertion below would still agree.
 */
function emitSourceFiles(): readonly string[] {
  return sourceFiles().filter((file) => !file.endsWith('/topics.ts'))
}

/**
 * Every topic literal in this service's namespace that appears anywhere in `src/`.
 *
 * Deliberately broader than `topic: '<name>'`, which is what identity's equivalent matches: a scan
 * tied to the emit-site shape misses a CONSTANT that no emit site uses, and that is a real defect
 * — `market.order.refunded` was declared, exported, emitted by nothing, and a name a consumer
 * could have subscribed to for ever.
 *
 * Comment lines are skipped, and that is load-bearing rather than tidy: `outbox.ts` carries a
 * worked `emit({ topic: 'market.listing.sold' … })` example in its header, and counting it would
 * report a topic no code path produces.
 *
 * `action:` and `scope:` lines are skipped for a sharper reason: the policy and scope vocabularies
 * share this namespace. A permission such as `trade.bot.write` is three lowercase segments and
 * looks exactly like a topic, and nothing emits it.
 */
function topicsInSource(): readonly string[] {
  const found = new Set<string>()
  const literal = new RegExp(`'(${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+)'`, 'g')
  for (const file of emitSourceFiles()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (/\b(?:action|scope|resource|permission)\s*:/.test(line)) continue
      for (const match of line.matchAll(literal)) if (match[1]) found.add(match[1])
    }
  }
  return [...found].sort()
}

/* ------------------------------------------------------------------ the names */

test('the source emits exactly the topics this service declares', () => {
  // Both halves of the drift: a literal `src/` spells that EMITTED_TOPICS does not list, and an
  // entry in EMITTED_TOPICS that no literal backs. The second half is what stops the list being
  // repaired by editing the list.
  assert.deepEqual(
    topicsInSource(),
    [...EMITTED_TOPICS].sort(),
    'src/ and EMITTED_TOPICS disagree about what this service puts on the bus',
  )
})

test('every topic this service emits is one the estate has a name for', () => {
  assert.deepEqual(
    undeclaredTopics(topicsInSource()),
    [],
    'emitted, but in neither the registry nor AWAITING_REGISTRATION — decide which, then say so',
  )
})

test('every registry topic this service owns is actually emitted', () => {
  // The feature-that-can-never-fire direction, and the one that fails silently in production:
  // consumers classify the topic, the code path renders it, and nothing ever arrives.
  assert.deepEqual(
    unemittedOwnedTopics(topicsInSource()),
    [],
    'the registry says trade produces these and no emit site does — every consumer of each is dead code',
  )
  // And the registry is being read rather than the check passing vacuously.
  assert.ok(TOPIC_NAMES.length >= 40, 'the registry is being read rather than the check passing vacuously')
})

test('a pending proposal disappears once contracts adopts it', () => {
  // Without this the quarantine becomes a permanent allow-list: the topic gets registered, the
  // entry stays, and the next reader believes the topic is still unregistered.
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
  // Every emitted topic is accounted for EXACTLY once — registered or quarantined, never both and
  // never neither. This replaces two counts (`topicsProducedBy(SERVICE).length === 0` and
  // `AWAITING_REGISTRATION.length === EMITTED_TOPICS.length`) that were true only while the
  // registry owned no trade topic, and that a reader could have restored to green by adjusting a
  // number. A partition cannot be satisfied by editing one side.
  assert.deepEqual(
    [...topicsProducedBy(SERVICE), ...Object.keys(AWAITING_REGISTRATION)].sort(),
    [...EMITTED_TOPICS].sort(),
    'an emitted topic is registered or quarantined — this says it is neither, or counted twice',
  )
  // And the split itself, pinned, so moving a topic across the line is a deliberate edit here.
  // The line has moved once and is now at the end: `trade.bot.paused` was adopted alone
  // (micro-contracts 8889373) and the other six followed with micro-org#345, so the registry owns
  // all seven and the quarantine owns none. Pinned as an EQUALITY against `EMITTED_TOPICS` rather
  // than as a count, because a count is the thing a reader can restore to green by adjusting a
  // number — and pinned in both tables, because "registered" and "not quarantined" are two facts.
  assert.deepEqual([...topicsProducedBy(SERVICE)].sort(), [...EMITTED_TOPICS].sort())
  assert.deepEqual(Object.keys(AWAITING_REGISTRATION), [])
})

/**
 * The `custody` defect, asked from this side of the wire.
 *
 * `keyedBy` is prose in the registry — a column name, not a type — so nothing in the contract can
 * force an emit site to pass what it names. Both of custody's ceremony topics were registered
 * `keyedBy: 'user_id'` while the emit sites passed the ADDRESS, and `activity` reads the envelope
 * key AS the subject id, so every export was filed against a user that does not exist. Every name
 * check in the estate passed throughout, because every name was right.
 *
 * `micro-contracts` checked this once, by reading `bots.ts` while adopting the spec. That is a
 * check with no expiry date attached: it cannot notice the emit site changing afterwards. This is
 * the standing version — it reads the real emit site out of `src/` and matches it against the
 * registered `keyedBy`, so moving the key to (say) `bot.userId` goes red here rather than silently
 * refiling every pause event against the wrong aggregate.
 *
 * It covered one topic while six sat in the quarantine, where `malformedProposals()` could check
 * the spec's SHAPE and nothing could check it against the code. All seven were registered together
 * (micro-org#345), so all seven are checked here — and the six new ones are where the custody
 * defect would have landed, because four of them move money and each has a second id in scope at
 * the emit: `transfer.userId` beside `transfer.id`, `bot.userId` beside `bot.id`, `value.fill.botId`
 * beside `value.fill.id`.
 */

/**
 * What each emit site really passes as the key, and what the registry must therefore say.
 *
 * Read off `src/` on 2026-08-10 while the six specs were being pasted into the registry, which is
 * the only moment the two can be reconciled by hand — after that this test is the reconciliation.
 * The `keyedBy` column is the ASSERTION, not a copy of the registry: it is what a reader of this
 * file would say the expression means, so a registry entry edited to match a changed emit still
 * has to come past a human here.
 */
const EMIT_SITES = Object.freeze({
  'trade.bot.created': { file: 'bots.ts', key: 'bot.id', keyedBy: 'bot_id' },
  'trade.bot.started': { file: 'bots.ts', key: 'bot.id', keyedBy: 'bot_id' },
  'trade.bot.paused': { file: 'bots.ts', key: 'bot.id', keyedBy: 'bot_id' },
  // `fill.id`, not `value.fill.id`, since micro-org#367 moved the emit INSIDE `applyFill`'s
  // transaction — the row is in scope there and the post-commit `value` wrapper is gone. Same
  // aggregate, so the registry entry did not move.
  'trade.fill.settled': { file: 'fills.ts', key: 'fill.id', keyedBy: 'fill_id' },
  'trade.fee.settled': { file: 'fees.ts', key: 'row.id', keyedBy: 'settlement_id' },
  'trade.order.filled': { file: 'exchange.ts', key: 'order.id', keyedBy: 'order_id' },
  'trade.transfer.settled': { file: 'transfers.ts', key: 'transfer.id', keyedBy: 'transfer_id' },
} as const)

test('every key these emit sites pass is the key the registry says they pass', () => {
  // The table covers the emitted set exactly, so adding a topic without adding it here fails
  // rather than being silently unchecked — the property the one-topic version of this test did
  // not have and did not need.
  assert.deepEqual(Object.keys(EMIT_SITES).sort(), [...EMITTED_TOPICS].sort())

  for (const [topic, site] of Object.entries(EMIT_SITES)) {
    assert.equal(
      TOPICS[topic as TopicName].keyedBy,
      site.keyedBy,
      `${topic}: the registered ordering key changed under this emit site`,
    )

    const lines = readFileSync(join(SRC, site.file), 'utf8').split('\n')
    const emits = lines
      .map((line, index) => ({ index, at: `${site.file}:${index + 1}` }))
      .filter(({ index }) => lines[index]!.includes(`topic: '${topic}'`))
    // If an emit moves or is duplicated, this is what notices — a second emit site is how one topic
    // acquires two payload shapes, which is the thing that made `identity.mfa.changed`
    // unregisterable by construction.
    assert.equal(emits.length, 1, `${topic} should have exactly one emit site`)

    // `key:` is on the emit's own line for the one-line calls and on the next for the rest, so the
    // window is three lines and never wider: a wider one would start matching the NEXT emit's key
    // in `bots.ts`, where three of these live within a dozen lines of each other.
    const window = lines.slice(emits[0]!.index, emits[0]!.index + 3).join('\n')
    const expected = new RegExp(`key: ${site.key.replace(/\./g, '\\.')}(?![\\w.])`)
    assert.match(
      window,
      expected,
      `${emits[0]!.at} passes something other than ${site.key} as the key, while the registry says ${site.keyedBy}`,
    )
  }
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a well-formed trade topic, a real ordering key, and a reason worth reading',
  )
})

/* ------------------------------------------------------------------ the envelope */

const ROW = {
  id: '018f0000-0000-7000-8000-0000000000a1',
  topic: 'trade.bot.started',
  key: '018f0000-0000-7000-8000-0000000000b1',
  occurred_at: new Date('2026-08-03T10:00:00.000Z'),
  producer: SERVICE,
  version: 1,
  actor: 'user:018f0000-0000-7000-8000-0000000000c1',
  correlation_id: 'req-1',
  payload: { botId: 'b-1' },
}

test('THE RULE: the envelope this relay builds is one the contract accepts', () => {
  // The check whose absence let six producers relay nothing but refusals. `validateEnvelope` is
  // the contract's own function and is literally what activity/src/ingest.ts and notify run on a
  // delivered body — not a restatement of it here.
  for (const topic of topicsInSource()) {
    const envelope = buildEnvelope({ ...ROW, topic })
    assert.deepEqual(
      envelopeDefects(JSON.parse(JSON.stringify(envelope))),
      [],
      `an event on ${topic} would be refused by every consumer in the estate`,
    )
  }
})

test('the version on the wire is "major.minor", never the stored integer', () => {
  const envelope = buildEnvelope(ROW)
  // The specific defect, named, so a reader of a failure knows what broke.
  assert.equal(typeof envelope.version, 'string')
  assert.equal(envelope.version, '1.0')
  assert.equal(parseVersion(envelope.version).ok, true)
  assert.equal(parseVersion(String(ROW.version)).ok, false, 'the stored integer is NOT a wire version')
})

test('a row with no actor and no correlation id still makes a readable envelope', () => {
  // Both columns are nullable and both are refused by the contract if they arrive null. The
  // fallbacks are the contract's own semantics: a service actor, and an event that is its own
  // correlation root.
  const envelope = buildEnvelope({ ...ROW, actor: null, correlation_id: null })
  assert.equal(envelope.actor, 'service:trade')
  assert.equal(envelope.correlationId, ROW.id)
  assert.deepEqual(envelopeDefects(JSON.parse(JSON.stringify(envelope))), [])
})

test('envelopeDefects excuses a lagging registry and nothing else', () => {
  // The tolerance is narrow on purpose. An unregistered topic this repository has explained is a
  // consumer being behind its producers; anything else is this service emitting the unreadable.
  //
  // The quarantine is EMPTY as of micro-org#345, so the excusing branch has nothing to excuse and
  // this test drives it with a topic the quarantine names rather than with one it does not — which
  // would have been an assertion that could not fail. The tolerance is exercised through the
  // function's own input, not through a fixture that happens to be quarantined this week.
  assert.deepEqual(Object.keys(AWAITING_REGISTRATION), [], 'a proposal is back; drive it with that one')
  const registered = buildEnvelope({ ...ROW, topic: 'trade.fill.settled' })
  assert.deepEqual(envelopeDefects(JSON.parse(JSON.stringify(registered))), [])

  // An unregistered topic the quarantine does NOT explain is not excused — and today that is every
  // unregistered topic, which is the point of an empty quarantine rather than a gap in the test.
  const unexplained = { ...buildEnvelope(ROW), topic: 'trade.nothing.happened' }
  assert.ok(envelopeDefects(unexplained).length > 0)

  // And a real envelope defect is never excused, however the topic is registered. This is the
  // assertion that stopped the check being vacuous while six topics rode the quarantine.
  for (const envelope of [registered, { ...buildEnvelope(ROW), topic: 'trade.nothing.happened' }]) {
    const broken = { ...envelope, version: 1 as unknown as string }
    assert.ok(
      envelopeDefects(broken).some((error) => error.startsWith('version:')),
      `an integer version must be reported on ${String(broken.topic)}`,
    )
  }
})

/**
 * The case that separates this repository's `envelopeDefects` from the contract's own
 * `envelopeDefects(value, awaitingRegistration)`, which ships beside `classifyEnvelope` and looks
 * like a drop-in for it.
 *
 * "Malformed" and "not in this registry" are two facts with two remedies — a producer bug, and a
 * missing registration — and an envelope can carry both. `classifyEnvelope` keeps both, deliberately
 * (`unregisteredTopic` survives on a `malformed` verdict). The contract's flattening wrapper drops
 * the topic whenever any other defect is present, so the author is sent to fix one thing twice.
 *
 * Every other assertion in this suite stays green under that wrapper. This is the only one that
 * would go red, which is the point of writing it.
 */
test('an unproposed topic AND a broken version are reported together, not one per round', () => {
  const both = {
    ...buildEnvelope(ROW),
    topic: 'trade.nothing.happened',
    version: 1 as unknown as string,
  }
  const defects = envelopeDefects(both)
  assert.ok(
    defects.some((error) => error.startsWith('version:')),
    `the producer bug must be named: ${defects.join('; ')}`,
  )
  assert.ok(
    defects.some((error) => error.includes('trade.nothing.happened')),
    `the missing registration must be named too: ${defects.join('; ')}`,
  )
})

test('the delivery this relay signs is one a contract-following consumer verifies', () => {
  // The other half of the same story: the header name and the signature scheme are the contract's
  // too. Five producers carried drifted local copies (`x-cloudsforge-signature`, `sha256=<hmac>`)
  // and every delivery to activity or notify was refused as "signature: missing".
  const body = JSON.stringify(buildEnvelope(ROW))
  const secret = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'
  assert.equal(SIGNATURE_HEADER, 'cf-signature')
  const verification = verifyDelivery(body, signEvent(body, secret), [secret])
  assert.equal(verification.ok, true)
})

/**
 * The verifier takes a LIST, and the list is not looped over here.
 *
 * `verifyEventSignature` passes the candidates straight into the contract's `verifyDelivery`, which
 * is where the timing-safe comparison and the freshness window live. Looping in this service would
 * mean re-deriving both, and a byte-at-a-time comparison of a MAC is a forgery oracle.
 */
test('a delivery signed with a superseded secret verifies while the new secret leads the list', () => {
  const body = JSON.stringify(buildEnvelope(ROW))
  // Obviously fake, and long enough to clear the 24-character rule the env applies to each entry.
  const superseded = 'superseded-secret-0000000000000000'
  const rotated = 'rotated-secret-00000000000000000000'
  // The exact shape a rolling rotation depends on: newest first, signed with the old one.
  assert.equal(verifyEventSignature(body, [rotated, superseded], signEvent(body, superseded)), true)
  // And the scalar form still works, because nothing that passes one secret had to change.
  assert.equal(verifyEventSignature(body, superseded, signEvent(body, superseded)), true)
  // Dropping the old secret from the list is what finishes the rotation, so it must actually stop.
  assert.equal(verifyEventSignature(body, [rotated], signEvent(body, superseded)), false)
})

/* ------------------------------------------------------------------ reachability */

/**
 * A guard that proves a topic name is correct proves nothing about whether the emit is reached.
 *
 * `identity/src/sessions.ts` exports `emitSessionRevoked` and NOTHING CALLS IT — `revokeSession`
 * and `revokeAllSessions` update rows without emitting — so `identity.session.revoked` is produced
 * by dead code while identity's own guard passes, because it scans literals rather than
 * reachability. This is the cheapest check that catches that exact shape.
 *
 * ## An import is not a call, and this used to think it was
 *
 * The scan below asks whether any line in `src/` mentions the symbol. An `import { emitFoo } from
 * './foo.ts'` line mentions it, so a symbol that was imported and then never called read as
 * reached. That is not hypothetical: deleting BOTH `emitKeyRevoked` call sites from `server.ts` and
 * leaving its import left `micro-devplatform`'s suite fully green, with
 * `devplatform.key.revoked` — the topic `11-data-and-contract-strategy.md` names as the
 * estate's key-cache flush — produced by nothing at all. The identical detector was here. The check could not fail in exactly the case it was written for, because the
 * import that survives a deleted call is the FIRST thing a reader would delete last.
 *
 * This is the same family as the defect it was written to catch: a scan that counts a MENTION as a
 * USE. So imports and re-exports are stripped before the reference scan. Blank lines are left in
 * their place, so line numbers in the declaration scan still name the real line.
 *
 * The detector is exercised on fixtures FIRST, including that exact case. A repository with no
 * exported emitter would otherwise get a green from a scan that finds nothing because it is broken,
 * which is precisely the "check that cannot fail" this estate keeps rediscovering — and it is not
 * hypothetical here either: THIS repository declares no exported emitter at all, so the
 * fixtures below are the ONLY thing exercising this code here.
 */
function withoutImports(text: string): string {
  const kept: string[] = []
  let inDeclaration = false
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    // `export { x } from './y.ts'` re-exports a symbol without using it, exactly as an import does.
    const opens = !inDeclaration && /^(?:import\b|export\s*\{[^}]*$|export\s*\{[^}]*\}\s*from\b)/.test(trimmed)
    if (opens) {
      // A bare `import './x.ts'` and a one-line `import { a } from './x.ts'` both close at once; a
      // braced list spread over several lines closes at the `from '…'`.
      inDeclaration = !/\bfrom\s+['"]/.test(line) && !/^import\s+['"]/.test(trimmed)
      kept.push('')
      continue
    }
    if (inDeclaration) {
      if (/\bfrom\s+['"]/.test(line)) inDeclaration = false
      kept.push('')
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

function unreachedEmitters(files: readonly { name: string; text: string }[]): readonly string[] {
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = /^export (?:async )?function (emit[A-Za-z0-9_]*)/.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  const bodies = files.map((file) => ({ name: file.name, text: withoutImports(file.text) }))
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of bodies) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (/^export (?:async )?function /.test(trimmed)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unreachable-emitter detector can actually fail', () => {
  // identity's defect, reproduced in miniature. Without this the assertion below is worth nothing
  // in a repository whose emit sites are all inline.
  const dead = [{ name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' }]
  assert.deepEqual(unreachedEmitters(dead), ['emitSessionRevoked (sessions.ts:1)'])

  const alive = [
    { name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' },
    { name: 'server.ts', text: 'emitSessionRevoked()\n' },
  ]
  assert.deepEqual(unreachedEmitters(alive), [])
})

/**
 * The case the detector used to get wrong, and the reason it is worth having at all.
 *
 * A dead emitter is almost never dead by having its import removed too — a call is deleted or
 * refactored away and the import is what lingers. Counting that import as a reference made this
 * check green in precisely the situation it exists for.
 */
test('an emitter that is imported but never called is NOT reached', () => {
  const importedOnly = [
    { name: 'apikeys.ts', text: 'export function emitKeyRevoked(): void {}\n' },
    {
      name: 'server.ts',
      text: "import { emitKeyRevoked, revokeApiKey } from './apikeys.ts'\nrevokeApiKey()\n",
    },
  ]
  assert.deepEqual(unreachedEmitters(importedOnly), ['emitKeyRevoked (apikeys.ts:1)'])

  // The multi-line form, which is how every import in this service is actually written.
  const multiline = [
    { name: 'apikeys.ts', text: 'export function emitKeyRevoked(): void {}\n' },
    {
      name: 'server.ts',
      text: "import {\n  emitKeyRevoked,\n  revokeApiKey,\n} from './apikeys.ts'\nrevokeApiKey()\n",
    },
  ]
  assert.deepEqual(unreachedEmitters(multiline), ['emitKeyRevoked (apikeys.ts:1)'])

  // A re-export is not a use either.
  const reExported = [
    { name: 'apikeys.ts', text: 'export function emitKeyRevoked(): void {}\n' },
    { name: 'index.ts', text: "export { emitKeyRevoked } from './apikeys.ts'\n" },
  ]
  assert.deepEqual(unreachedEmitters(reExported), ['emitKeyRevoked (apikeys.ts:1)'])

  // And stripping imports must not blind it to the call that FOLLOWS one.
  const importedAndCalled = [
    { name: 'apikeys.ts', text: 'export function emitKeyRevoked(): void {}\n' },
    {
      name: 'server.ts',
      text: "import {\n  emitKeyRevoked,\n} from './apikeys.ts'\nemitKeyRevoked()\n",
    },
  ]
  assert.deepEqual(unreachedEmitters(importedAndCalled), [])
})

test('every exported emitter is reached from somewhere', () => {
  assert.deepEqual(
    unreachedEmitters(sourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'exported, emits an event, and no code path reaches it — the topic is produced by dead code',
  )
})
