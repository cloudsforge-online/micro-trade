/**
 * Configuration.
 *
 * `loadEnv` is pure over its source so the failure paths are testable without mutating the process.
 * The two behaviours worth a test are the two that stop a bad deploy: a missing variable names
 * itself, and a placeholder secret is refused outright rather than booting.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const SECRET = 'a-real-looking-secret-of-sufficient-length'

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

const { EnvError, loadEnv, SERVICE } = await import('./env.ts')

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
  for (const placeholder of ['CHANGE_ME', 'changeme', 'change-me', 'dev-secret', 'placeholder']) {
    assert.throws(
      () => loadEnv({ ...base, OUTBOX_SIGNING_SECRET: placeholder }),
      (err: unknown) => err instanceof EnvError && err.message.includes('placeholder'),
      `${placeholder} was accepted`,
    )
  }
})

test('a short secret is refused, because length is the only entropy proxy available here', () => {
  assert.throws(
    () => loadEnv({ ...base, TRADE_SERVICE_TOKEN: 'short' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('at least 24 characters'),
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
