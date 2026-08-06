/**
 * Configuration.
 *
 * `loadEnv` is pure over its source so the failure paths are testable without mutating the process.
 * The two behaviours worth a test are the two that stop a bad deploy: a missing variable names
 * itself, and a placeholder secret is refused outright rather than booting.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'

/**
 * GENERATED, never written out.
 *
 * The former fixture here was `a-real-looking-secret-of-sufficient-length`, and it is exactly the
 * thing `@cloudsforge/secrets` now refuses: hyphens, no entropy, and a name that says out loud that
 * it only ever had to look the part. A fixture exempt from the rule it exercises is how the
 * placeholder in micro-org #142 passed every test in the estate.
 */
const SECRET = randomBytes(48).toString('base64')

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 */
const base: Record<string, string> = {
  TRADE_DATABASE_URL: 'postgres://trade:trade@127.0.0.1:5432/trade',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: SECRET,
  LEDGER_URL: 'http://127.0.0.1:4007',
  PRICING_URL: 'http://127.0.0.1:4006',
  BILLING_URL: 'http://127.0.0.1:4009',
  TRADE_SERVICE_TOKEN: SECRET,
}
for (const [key, value] of Object.entries(base)) process.env[key] = value

const { EnvError, loadEnv, parseSecretList, SERVICE } = await import('./env.ts')

/**
 * The two ends of a rotation window, GENERATED per run rather than written down.
 *
 * They used to be `accept-secret-newest-…` and `accept-secret-superseded-…`, which the accept list
 * now refuses for the same reason the scalar does. Generating them keeps the repository free of any
 * string that looks like a key — a committed literal cannot be told apart from a real one by a
 * future reader, and that ambiguity is what let #142 sit in a public file unread.
 */
const NEWEST = randomBytes(48).toString('base64')
const SUPERSEDED = randomBytes(48).toString('base64')

test('the service names itself, so two services cannot share a migration advisory lock', () => {
  assert.equal(SERVICE, 'trade')
})

test('a complete environment loads, and the optional values take their documented defaults', () => {
  const env = loadEnv(base, 'pod-1')
  assert.equal(env.port, 4000)
  assert.equal(env.logLevel, 'info')
  assert.equal(env.databasePoolMax, 10)
  assert.equal(env.upstreamDeadlineMs, 800)
  assert.equal(env.moneyDeadlineMs, 5_000)
  assert.equal(env.settlementPeriodSeconds, 3_600)
  assert.equal(env.instanceId, 'pod-1')
})

test('live trading is off unless a deploy turns it on, so money cannot move by default', () => {
  assert.equal(loadEnv(base).liveEnabled, false)
  assert.equal(loadEnv({ ...base, TRADE_LIVE_ENABLED: 'true' }).liveEnabled, true)
  assert.equal(loadEnv({ ...base, TRADE_LIVE_ENABLED: '1' }).liveEnabled, true)
  assert.equal(loadEnv({ ...base, TRADE_LIVE_ENABLED: 'false' }).liveEnabled, false)
})

test('a missing required variable names itself, rather than surfacing four layers later', () => {
  for (const name of Object.keys(base)) {
    const source = { ...base }
    delete source[name]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => err instanceof EnvError && err.message.includes(name),
      `${name} did not name itself`,
    )
  }
})

test('a placeholder secret is refused outright, because a placeholder that boots reaches production', () => {
  // No `instanceof EnvError` here, deliberately: the signing key is now gated by
  // `@cloudsforge/secrets`, which raises its own `SecretError`. What a caller needs from a refusal
  // is the variable, the reason and the fix, and none of those live in the class name.
  for (const placeholder of ['CHANGE_ME', 'changeme', 'change-me', 'dev-secret', 'placeholder']) {
    assert.throws(
      () => loadEnv({ ...base, OUTBOX_SIGNING_SECRET: placeholder }),
      (err: unknown) => (err as Error).message.includes('placeholder'),
      `${placeholder} was accepted`,
    )
  }
})

/**
 * THE VALUES THAT WERE ACTUALLY DEPLOYED, and every near miss with them.
 *
 * micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
 * 24-character floor — and each is a real string that was deployed, set in CI or used as a fixture,
 * not an invented one. The scalar AND the accept list are both checked, because a rotation window
 * is not a place where the bar drops: in an overlap the OUTGOING key is the one an attacker already
 * holds if it leaked, and "just for the drain" is how a placeholder survives the rotation that was
 * supposed to remove it.
 */
const DEPLOYED_PLACEHOLDERS = [
  'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
  'ci-only-not-a-real-secret-000000000000', // 23 CI workflows, this one among them
  'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // a sibling's env fixture: 32 chars, 24 bytes
  '0'.repeat(64), // right alphabet, right length, no entropy at all
]

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, as a scalar and inside the accept list', () => {
  const refusal = (value: string) => (err: unknown) => {
    // The refusal must not echo the value: the reason this guard exists is that the value was
    // readable, and a message carrying it moves the secret on to the log collector.
    const message = (err as Error).message
    assert.ok(!message.includes(value), 'the refusal echoed the value')
    assert.match(message, /OUTBOX_(SIGNING_SECRET|ACCEPT_SECRETS)/)
    assert.match(message, /openssl rand -base64 48/)
    return true
  }
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(() => loadEnv({ ...base, OUTBOX_SIGNING_SECRET: value }), refusal(value), `${value.slice(0, 12)}… was accepted as the signing secret`)
    assert.throws(
      () => loadEnv({ ...base, OUTBOX_ACCEPT_SECRETS: `${NEWEST},${value}` }),
      refusal(value),
      `${value.slice(0, 12)}… was accepted as an accept-list entry`,
    )
  }
})

test('a generated secret is accepted, in either alphabet, so the guard is not simply "no"', () => {
  // A guard that occasionally refuses correct input is a guard somebody removes. Both of the shapes
  // the runbook can produce have to pass.
  assert.doesNotThrow(() => loadEnv({ ...base, OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }))
  assert.doesNotThrow(() => loadEnv({ ...base, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }))
})

test('a short secret is refused, because length is the only entropy proxy available here', () => {
  assert.throws(
    () => loadEnv({ ...base, TRADE_SERVICE_TOKEN: 'short' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('at least 24 characters'),
  )
})

/* ---------------------------------------------------------- the rotation overlap window */

/**
 * `OUTBOX_SIGNING_SECRET` is one key shared across the estate, and it must be rotated. It signs the
 * outbox->inbox hop, so if a producer moves to a new secret while this receiver still holds only
 * the old one, delivery partitions silently — and what this service consumes on that hop is
 * `identity.user.deleted`, so a partition is an erasure obligation quietly not met.
 *
 * A rolling rotation is only possible if the RECEIVER accepts more than one secret at a time.
 * `verifyDelivery` has taken a list since `contracts/packages/events/src/index.ts`; what was
 * missing here was the env plumbing.
 */
test('OUTBOX_ACCEPT_SECRETS is absent by default, and the service accepts exactly the signing secret', () => {
  // The backwards-compatible path, and the reason this is safe to deploy on its own: unset, the
  // accept list is a one-element list holding today's secret, which is byte-for-byte the behaviour
  // of the scalar it replaces. Deploying this changes nothing; that is what lets the rotation be
  // staged afterwards, one service at a time.
  assert.deepEqual([...loadEnv(base).acceptSecrets], [SECRET])
})

test('OUTBOX_ACCEPT_SECRETS takes a list newest first, which is the overlap window itself', () => {
  const env = loadEnv({ ...base, OUTBOX_ACCEPT_SECRETS: `${NEWEST}, ${SUPERSEDED}` })
  assert.deepEqual([...env.acceptSecrets], [NEWEST, SUPERSEDED])
  // Signing is NOT widened. This service keeps emitting under one secret; only what it will accept
  // is plural, because a producer signing under two keys has not rotated, it has forked.
  assert.equal(env.outboxSigningSecret, SECRET)
})

test('every entry in OUTBOX_ACCEPT_SECRETS is validated exactly like the signing secret', () => {
  // No escape hatch: a list is not a way to smuggle in a value that would be refused on its own.
  assert.throws(
    () => loadEnv({ ...base, OUTBOX_ACCEPT_SECRETS: `${NEWEST},changeme` }),
    (err: unknown) => (err as Error).message.includes('placeholder'),
  )
  // The message names BYTES, not characters. That is the correction #142 turned on: the old floor
  // counted keystrokes, and 32 characters of prose is not 32 bytes of key.
  assert.throws(
    () => loadEnv({ ...base, OUTBOX_ACCEPT_SECRETS: `${NEWEST},short` }),
    (err: unknown) => /bytes of key material/.test((err as Error).message),
  )
  assert.throws(() => parseSecretList('', 'X'), EnvError)
  assert.throws(() => parseSecretList(' , , ', 'X'), EnvError)
})

test('OUTBOX_ACCEPT_SECRETS refuses the same secret twice, so "which key verified this" has an answer', () => {
  // `verifyDelivery` reports the INDEX of the key that matched, and that index is the only signal
  // that says every producer has moved off the old secret and it can be dropped. A duplicated
  // entry makes that answer ambiguous, so it is refused at boot rather than misread later.
  assert.throws(
    () => loadEnv({ ...base, OUTBOX_ACCEPT_SECRETS: `${NEWEST},${NEWEST}` }),
    (err: unknown) => err instanceof EnvError && err.message.includes('same secret twice'),
  )
})

test('an unparseable log level is refused rather than silently defaulting to info', () => {
  assert.throws(() => loadEnv({ ...base, LOG_LEVEL: 'chatty' }), EnvError)
  assert.equal(loadEnv({ ...base, LOG_LEVEL: 'debug' }).logLevel, 'debug')
})

test('a non-boolean kill-switch value is refused, so a typo cannot silently enable live trading', () => {
  assert.throws(() => loadEnv({ ...base, TRADE_LIVE_ENABLED: 'yes' }), EnvError)
})

test('an out-of-range number is refused with its bounds named', () => {
  assert.throws(() => loadEnv({ ...base, PORT: '0' }), EnvError)
  assert.throws(() => loadEnv({ ...base, PORT: '70000' }), EnvError)
  assert.throws(() => loadEnv({ ...base, TRADE_DATABASE_POOL_MAX: '1000' }), EnvError)
  assert.throws(() => loadEnv({ ...base, TRADE_SETTLEMENT_PERIOD_SECONDS: '1' }), EnvError)
  assert.throws(() => loadEnv({ ...base, PORT: '4000.5' }), EnvError)
})

test('the settlement period is configurable, because it is what makes (bot, period) a key', () => {
  assert.equal(loadEnv({ ...base, TRADE_SETTLEMENT_PERIOD_SECONDS: '86400' }).settlementPeriodSeconds, 86_400)
})

test('the instance id falls back to the hostname, which is what an operator would search for', () => {
  assert.equal(loadEnv(base, 'trade-7d9f').instanceId, 'trade-7d9f')
  assert.equal(loadEnv({ ...base, INSTANCE_ID: 'named' }, 'trade-7d9f').instanceId, 'named')
  assert.equal(loadEnv(base, '').instanceId, 'unknown')
})

test('exactly one database variable is read, so rule 1 cannot be broken by configuration', () => {
  // A second connection string is the first step of every distributed monolith ever built. There is
  // no field on `Env` that could hold one, and this asserts that stays true.
  const env = loadEnv(base)
  const values = Object.values(env).filter((value) => typeof value === 'string' && value.startsWith('postgres://'))
  assert.equal(values.length, 1)
})
