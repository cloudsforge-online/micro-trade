/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out has
 * nothing to justify it.
 *
 * The shape is the service-template's, unchanged. Two things are specific to trade:
 *
 *   1. **`TRADE_LIVE_ENABLED` is read on every tick, not at boot.** The frozen service read its
 *      equivalent only when a bot was created and when one was started
 *      (`crucible/services/crucible/src/runner.ts:47-58` describes the fix; the switch is consulted
 *      in the tick loop at `runner.ts:388`). A kill switch that only applies to bots that do not
 *      exist yet is not a kill switch. Here it is a field on a frozen object read per tick, which
 *      is the same property reached without a mutable global.
 *   2. **There is no market-feed credential and no exchange URL.** Candle data is not this
 *      service's to fetch — see the note in `src/series.ts`.
 */

import { hostname } from 'node:os'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'trade'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * Values that must never be accepted. Short on purpose: it holds the strings that actually appear
 * in this repository's own `.env.example`, because those are the ones that get copied into a
 * deployment by someone in a hurry.
 */
const PLACEHOLDERS = new Set([
  'change_me',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. Set above the point at which a
  // human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. CI greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  /** Hard upstream — every fill posting, every fee, every capital reservation. 07 §2. */
  readonly ledgerUrl: string
  /** Hard upstream — "a bot with no price does not trade". 07 §2. */
  readonly pricingUrl: string
  /** Soft upstream — subscription tier and limits, cached, last-known on failure. 07 §2. */
  readonly billingUrl: string
  /** This service's own scoped credential. Carries `ledger:post`, `ledger:reserve`, `pricing:read`. */
  readonly serviceToken: string
  /**
   * The money kill switch, read per tick.
   *
   * Live bots do not trade and no fee is settled while this is off. It is deliberately not a status
   * change: the operator's intent is to stop money moving, not to unwind everyone's positions, and
   * a bot left running resumes the moment the switch goes back on. Ported from
   * `crucible/services/crucible/src/runner.ts:47-58`.
   *
   * Defaults to **false**, and 17 §9 names that exact default as the reason Crucible's fee "is
   * complete, correct, well-designed and earns nothing". Built-and-off is the honest state; the
   * enabling condition is a deploy that sets this to true.
   */
  readonly liveEnabled: boolean
  /** `fast-read` profile from 07 §2. Applies to pricing and billing. */
  readonly upstreamDeadlineMs: number
  /** `money-write` profile from 07 §2. Applies to the ledger. No automatic retry at that budget. */
  readonly moneyDeadlineMs: number
  /**
   * The performance-fee accrual period, in seconds.
   *
   * This is what makes `(bot_id, period)` a well-defined unique key, which is the schema-level fix
   * for the double-billing the frozen service has. Default one hour, matching the frozen sweep's
   * cadence.
   */
  readonly settlementPeriodSeconds: number
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }
  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'TRADE_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'TRADE_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    ledgerUrl: required(source, 'LEDGER_URL'),
    pricingUrl: required(source, 'PRICING_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    serviceToken: requiredSecret(source, 'TRADE_SERVICE_TOKEN'),
    liveEnabled: boolean(source, 'TRADE_LIVE_ENABLED', false),
    upstreamDeadlineMs: integer(source, 'TRADE_UPSTREAM_DEADLINE_MS', 800, 100, 30_000),
    moneyDeadlineMs: integer(source, 'TRADE_MONEY_DEADLINE_MS', 5_000, 500, 60_000),
    settlementPeriodSeconds: integer(source, 'TRADE_SETTLEMENT_PERIOD_SECONDS', 3_600, 60, 86_400),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and the
 * only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and the
 * report of it. The message is the one `loadEnv` produced, which by construction never contains a
 * value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
