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
 *      (`crucible/services/crucible/src/runner.ts` describes the fix; the switch is consulted
 *      in the tick loop at `runner.ts`). A kill switch that only applies to bots that do not
 *      exist yet is not a kill switch. Here it is a field on a frozen object read per tick, which
 *      is the same property reached without a mutable global.
 *   2. **There is no market-feed credential and no exchange URL.** Candle data is not this
 *      service's to fetch — see the note in `src/series.ts`.
 */

import { hostname } from 'node:os'
import { assertGeneratedSecret, assertGeneratedSecretList } from '@cloudsforge/secrets'

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

/**
 * The estate's shared event-bus HMAC key, held to a SHAPE rather than to a deny-list.
 *
 * `requiredSecret` above cannot be the guard for this one. It refuses a fixed list of exact strings
 * and anything under 24 characters, and the value that sat on 54 lines of a PUBLIC compose file —
 * `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it passed
 * every service in the estate (micro-org #142). A check that could not fail read as the absence of
 * a problem. Here that key is also what verifies `identity.user.deleted` on `POST /v1/events`, so a
 * forgeable one is a delete-anyone endpoint.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` rather than `requiredSecret`, deliberately: the weaker checks are a strict subset of
 * the stronger ones, and running them first would answer a 40-character placeholder with "must be
 * at least 24 characters" — a message that is true, useless, and points the operator at the wrong
 * property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  assertGeneratedSecret(name, value)
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

/**
 * The secrets the inbound event route accepts, newest first.
 *
 * A LIST, not a value, because rotating `OUTBOX_SIGNING_SECRET` without an overlap window would
 * require every producer in the estate to change secret in the same instant this service does, and
 * that instant does not exist during a rolling deploy. A producer that moved first would simply be
 * refused — and the topic this service consumes on that hop is `identity.user.deleted`, so a silent
 * partition is an erasure obligation quietly not met.
 *
 * Copied from `devplatform/src/env.ts`, which took the shape from activity's
 * `ACTIVITY_INGEST_SECRETS`. Each entry is validated exactly as the signing secret is, by the same
 * `@cloudsforge/secrets` gate: a list is not a way to smuggle in a value that would be refused on
 * its own. The list does NOT get a weaker rule because it is "just for the drain" — in an overlap
 * window the OUTGOING key is the one an attacker already holds if it leaked, and "just for the
 * drain" is exactly how a placeholder survives the rotation meant to remove it (micro-org #142).
 *
 * The old per-entry checks — the `PLACEHOLDERS` set and a 24-character floor — are gone rather than
 * kept in front, for the reason given on `requiredSigningSecret`: they are a strict subset of the
 * shape check, and running them first answers a 40-character placeholder by complaining about its
 * length. What stays is what the shape check does not do: the "at least one entry" rule, because an
 * empty accept list is a silent partition, and the duplicate rule below.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  assertGeneratedSecretList(name, entries)
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes the "which key verified this" answer ambiguous, and that answer is
    // what tells an operator whether a rotation has finished and the old key can be dropped.
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
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
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * HMAC key for outbound event signatures, so a subscriber can prove an event came from us.
   * Exactly one, always: a producer signing under two keys at once has not rotated, it has forked.
   */
  readonly outboxSigningSecret: string
  /**
   * The secrets `POST /v1/events` will ACCEPT, newest first.
   *
   * Defaults to `[outboxSigningSecret]` when `OUTBOX_ACCEPT_SECRETS` is unset, so a deploy that
   * does not set it behaves exactly as it does today. That is deliberate: it makes shipping this
   * change a no-op, which is what lets the estate's shared secret be rotated one service at a time
   * afterwards rather than on a flag day.
   */
  readonly acceptSecrets: readonly string[]
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
   * `crucible/services/crucible/src/runner.ts`.
   *
   * Defaults to **false**, and 17 §9 names that exact default as the reason Crucible's fee "is
   * complete, correct, well-designed and earns nothing". Built-and-off is the honest state; the
   * enabling condition is a deploy that sets this to true.
   */
  readonly liveEnabled: boolean
  /**
   * The order book, off by default.
   *
   * The exchange is a DIFFERENT REGULATORY OBJECT from everything else this service does. A
   * backtest is a simulation, a bot converts one customer's money against a price feed, and both
   * are things this estate already does. Matching two customers' orders against each other is
   * operating a trading venue, and `docs/ecosystem/16-risks-and-open-decisions.md` R-54 names
   * exactly that — "any proposal to match two users' conversions" — as the early warning that the
   * unlicensed-exchange risk has been crossed.
   *
   * So it is built, tested, and shipped OFF. `GET /v1/capabilities` reports the flag, every
   * exchange route answers 503 while it is false, and turning it on is a deliberate, recorded act
   * by somebody who has answered the question R-54 asks. That is the same shape as
   * `TRADE_LIVE_ENABLED` and for a related reason: the code being correct is not the same fact as
   * the business being permitted to run it.
   */
  readonly exchangeEnabled: boolean
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
  // Read before the object literal because the accept list falls back to it.
  const outboxSigningSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET')
  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'TRADE_DATABASE_URL'),
    databaseUrlTestnet: source['TRADE_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'TRADE_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    acceptSecrets: parseSecretList(
      optional(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
      'OUTBOX_ACCEPT_SECRETS',
    ),
    ledgerUrl: required(source, 'LEDGER_URL'),
    pricingUrl: required(source, 'PRICING_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    serviceToken: requiredSecret(source, 'TRADE_SERVICE_TOKEN'),
    liveEnabled: boolean(source, 'TRADE_LIVE_ENABLED', false),
    exchangeEnabled: boolean(source, 'TRADE_EXCHANGE_ENABLED', false),
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
