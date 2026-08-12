/**
 * The database harness and the fakes.
 *
 * Not a test file itself — it is excluded from the build and contains no `test()` call.
 *
 * The fakes here are **real objects with real behaviour**, never a mocking library. `fakeLedger`
 * replays by idempotency key, refuses on an insufficient balance and can lose an answer on demand,
 * because the properties this repository has to hold down are not about any single call — they are
 * about what the NEXT pass does after a call whose answer never arrived. That is only testable
 * against a ledger that can commit a charge and lose the response. The frozen service reached the
 * same conclusion and injected its ports for the same reason
 * (`crucible/services/crucible/src/fees.ts`).
 */

import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Principal } from '@cloudsforge/auth'
import { TokenError, VerifierUnavailableError } from '@cloudsforge/auth'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { RateUnavailableError, type PricingClient, type Quote, type QuoteSource } from './pricingclient.ts'
import {
  LedgerInFlightError,
  LedgerRefusedError,
  LedgerUnavailableError,
  type LedgerClient,
  type PostEntryRequest,
  type PostedEntry,
} from './ledgerclient.ts'
import { RATE_SCALE } from './money.ts'
import type { Bar } from './indicators.ts'
import type { Clock } from './rng.ts'
import type { Db } from './outbox.ts'

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'

/* ------------------------------------------------------------------ the database harness */

/**
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetTrade` truncates every table this service owns, and requiring "test" in
 * the name is the difference between a red build and an emptied environment. This service holds the
 * only record of which fills were settled and which fees were charged; the wrong connection string
 * here destroys the evidence every double-billing investigation would ever run on.
 *
 * ## The variable is `TRADE_TEST_DATABASE_URL`, as in every sibling
 *
 * It was briefly `TRADE_TEST_DSN`, to dodge two defects in the org's reusable `service-ci.yml`
 * that this repository found and reported: rule 1 compared reads against the one declared database
 * variable by exact string, so a service's own test DSN counted as another service's database; and
 * it grepped raw source, so naming the rejected spelling in a comment explaining the rejection
 * failed the build. Both are fixed in `micro-org` — the rule now compares namespaces and strips
 * comments first — so the workaround is gone and the name matches the other fifteen services.
 *
 * Keeping it would have been worse than untidy. CI exports the DSN as
 * `<SERVICE>_TEST_DATABASE_URL`; a suite reading a differently-spelled variable would not have
 * found it, would have skipped every database test, and would have reported green.
 */
const url = process.env['TRADE_TEST_DATABASE_URL']

export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set TRADE_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url as string, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture would
 * let the constraints drift out of the tests that are supposed to prove they fire — and
 * `fee_settlements_bot_period_uniq` and `fills_bot_bar_side_uniq` are the two most important lines
 * in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'trade-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetTrade(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'trade-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

let counter = 0
/** A unique idempotency key per call, so tests never collide on a reused key by accident. */
export function freshKey(prefix = 'k'): string {
  counter += 1
  return `${prefix}-${process.pid}-${Date.now()}-${counter}`
}

/* ------------------------------------------------------------------ the clock */

/** A clock the test moves by hand. Nothing in the engine or the tick reads `Date.now()` directly. */
export interface TestClock extends Clock {
  set(ms: number): void
  advance(ms: number): void
}

export function testClock(atMs = Date.parse('2026-07-01T00:00:00.000Z')): TestClock {
  let now = atMs
  return {
    now: () => now,
    set: (ms) => {
      now = ms
    },
    advance: (ms) => {
      now += ms
    },
  }
}

/* ------------------------------------------------------------------ pricing */

export interface FakePricing extends PricingClient {
  set(asset: string, midScaled: bigint, spreadBps?: number): void
  /**
   * The same, from an operator-set price rather than a market one.
   *
   * Separate from `set` rather than a fourth argument, so a test that means to exercise
   * micro-org#368's administered case has to say so at the call site and cannot get there by
   * leaving a default alone.
   */
  setAdministered(asset: string, midScaled: bigint, spreadBps?: number): void
  /** Make the asset unquotable, with the reason a caller will see. */
  unset(asset: string, reason?: string): void
}

export function fakePricing(): FakePricing {
  const quotes = new Map<string, Quote>()
  const reasons = new Map<string, string>()
  const quoted = (asset: string, midScaled: bigint, spreadBps: number, source: QuoteSource): void => {
    const delta = (midScaled * BigInt(spreadBps)) / 10_000n
    quotes.set(asset, {
      assetCode: asset as never,
      midScaled,
      buyScaled: midScaled + delta,
      sellScaled: midScaled - delta,
      asOf: '2026-07-01T00:00:00.000Z',
      source,
    })
    reasons.delete(asset)
  }
  return {
    set(asset, midScaled, spreadBps = 50) {
      quoted(asset, midScaled, spreadBps, 'market')
    },
    setAdministered(asset, midScaled, spreadBps = 50) {
      quoted(asset, midScaled, spreadBps, 'administered')
    },
    unset(asset, reason = 'no quote yet') {
      quotes.delete(asset)
      reasons.set(asset, reason)
    },
    async quote(asset) {
      const found = quotes.get(asset)
      if (!found) throw new RateUnavailableError(asset, reasons.get(asset) ?? 'not on the rate board')
      return found
    },
  }
}

/* ------------------------------------------------------------------ the ledger */

export interface FakeLedger extends LedgerClient {
  readonly entries: readonly PostEntryRequest[]
  readonly keys: readonly string[]
  /** US cents the subject can spend. Charges above it are refused with `insufficient_funds`. */
  setBalance(userId: string, usdCents: bigint): void
  /**
   * The same thing for any subject and any asset, which is what the exchange's transfers need.
   *
   * A deposit debits `user:<id>` in the market's own asset and a withdrawal debits `exchange`, so
   * neither is expressible as a cent balance. A subject/asset pair that has never been set is
   * UNLIMITED, which is why adding this changes nothing for the tests that came before it.
   */
  setAssetBalance(subject: string, asset: string, amount: bigint): void
  /** Hide the balance entirely, as an outage does. `availableUsdCents` then answers null. */
  hideBalance(hidden: boolean): void
  /**
   * **Commit the next charge and lose the answer.**
   *
   * The single most important behaviour in this file. It is the shape of a timeout that fired while
   * the transaction committed, and reproducing it is the only way to show that the next pass
   * re-sends the same key rather than billing again under a new one.
   */
  commitThenLoseAnswer(count?: number): void
  /** Fail the next N calls without committing, as an unreachable ledger does. */
  failNext(count: number): void
  /** Answer `idempotency_in_flight` on the next N calls. */
  inFlightNext(count: number): void
}

export function fakeLedger(): FakeLedger {
  const entries: PostEntryRequest[] = []
  const keys: string[] = []
  const byKey = new Map<string, PostedEntry>()
  const balances = new Map<string, bigint>()
  let hidden = false
  let loseAnswer = 0
  let failures = 0
  let inFlight = 0
  let sequence = 0

  /** `<subject>|<asset>`, the granularity a real ledger account has. */
  const slot = (subject: string, asset: string): string => `${subject}|${asset}`

  /**
   * What one entry takes out of each account, by subject and asset.
   *
   * Every debit is counted, not just the ones on the subject that happens to appear first. The
   * earlier version summed one subject's SHARD debits and nothing else, which meant a fake with a
   * balance set could not refuse an entry that overdrew a different account in the same entry — and
   * the exchange's withdrawals overdraw exactly such an account.
   */
  const debitsOf = (postings: PostEntryRequest['postings']): Map<string, bigint> => {
    const spend = new Map<string, bigint>()
    for (const posting of postings) {
      if (posting.direction !== 'debit') continue
      const key = slot(posting.account.subject, posting.assetCode)
      spend.set(key, (spend.get(key) ?? 0n) + posting.amount)
    }
    return spend
  }

  const commit = (request: PostEntryRequest): PostedEntry => {
    sequence += 1
    entries.push(request)
    const entry: PostedEntry = {
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      kind: request.kind,
      recordedAt: new Date(sequence).toISOString(),
      replayed: false,
    }
    byKey.set(request.idempotencyKey, entry)
    return entry
  }

  return {
    entries,
    keys,
    // The SHARD slot, matching the real client: micro-ledger holds live capital in SHARD and the
    // amount is a cent count at the 1:1 peg. See `src/ledgerclient.ts`.
    setBalance(userId, usdCents) {
      balances.set(slot(`user:${userId}`, 'SHARD'), usdCents)
    },
    setAssetBalance(subject, asset, amount) {
      balances.set(slot(subject, asset), amount)
    },
    hideBalance(value) {
      hidden = value
    },
    commitThenLoseAnswer(count = 1) {
      loseAnswer = count
    },
    failNext(count) {
      failures = count
    },
    inFlightNext(count) {
      inFlight = count
    },

    async postEntry(request) {
      keys.push(request.idempotencyKey)

      // Reachability is decided BEFORE the replay, because a ledger that is down cannot replay a
      // stored response any more than it can commit a new one. Checking the replay first would make
      // an unreachable ledger silently answer from its own memory, and a caller that depends on
      // "the outcome stays unknown while the ledger is down" would pass against a fake that never
      // stays unknown.
      if (inFlight > 0) {
        inFlight -= 1
        throw new LedgerInFlightError()
      }
      if (failures > 0) {
        failures -= 1
        // Nothing committed. This is the honest "we do not know, and in fact nothing happened" case.
        throw new LedgerUnavailableError('the ledger is unreachable')
      }

      // The stored response is returned without re-running the work. A fake that re-charged on a
      // replay would let a broken caller pass.
      const replay = byKey.get(request.idempotencyKey)
      if (replay) return { ...replay, replayed: true }

      // Checked in full BEFORE anything is deducted, so a refusal leaves every balance untouched.
      // Deducting as it went would half-apply an entry the ledger then refuses, and a fake that can
      // leave a partial entry behind is a fake that can make a caller's retry look wrong.
      const spend = debitsOf(request.postings)
      for (const [key, amount] of spend) {
        const available = balances.get(key)
        if (available !== undefined && amount > available) {
          // Refused on the balance. The claim rolls back with the posting, so the key is free again —
          // which is what makes a smaller charge under the SAME key safe. See `collect` in fees.ts.
          throw new LedgerRefusedError(409, 'insufficient_funds', `${key} cannot cover ${amount}`)
        }
      }
      for (const [key, amount] of spend) {
        const available = balances.get(key)
        if (available !== undefined) balances.set(key, available - amount)
      }
      // Credits are applied to accounts a test has said it is tracking, and only those. Without this
      // a deposit followed by a withdrawal would find the exchange's escrow no richer than it
      // started, and the withdrawal would be refused for a reason that exists only in the fake.
      for (const posting of request.postings) {
        if (posting.direction !== 'credit') continue
        const key = slot(posting.account.subject, posting.assetCode)
        const held = balances.get(key)
        if (held !== undefined) balances.set(key, held + posting.amount)
      }

      const entry = commit(request)
      if (loseAnswer > 0) {
        loseAnswer -= 1
        // Committed, and the caller will never hear about it. The key is now in `byKey`, so the next
        // attempt under the same key replays — and an attempt under a DIFFERENT key would charge a
        // second time, which is exactly the failure the invariants exist to prevent.
        throw new LedgerUnavailableError('the ledger timed out after 5000ms')
      }
      return entry
    },

    async reserve(request) {
      keys.push(request.idempotencyKey)
      const replay = byKey.get(request.idempotencyKey)
      if (replay) return { reservationId: replay.id, replayed: true }
      if (failures > 0) {
        failures -= 1
        throw new LedgerUnavailableError('the ledger is unreachable')
      }
      const available = balances.get(slot(request.subject, request.assetCode))
      if (available !== undefined && request.amount > available) {
        throw new LedgerRefusedError(409, 'insufficient_funds', 'cannot reserve more than is available')
      }
      const entry = commit({
        kind: 'transfer',
        actor: request.actor,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        postings: [],
      })
      return { reservationId: entry.id, replayed: false }
    },

    async release(_reservationId, request) {
      keys.push(request.idempotencyKey)
      const replay = byKey.get(request.idempotencyKey)
      if (replay) return { ...replay, replayed: true }
      return commit({
        kind: 'transfer',
        actor: request.actor,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        postings: [],
      })
    },

    async availableUsdCents(userId) {
      if (hidden) return null
      return balances.get(slot(`user:${userId}`, 'SHARD')) ?? null
    },
  }
}

/* ------------------------------------------------------------------ auth */

export const EVENT_SECRET = 'a-real-looking-secret-of-sufficient-length'

/**
 * A fake verifier keyed on opaque token strings.
 *
 * The mapping from auth fault to HTTP status is what is under test here, not `jose`. A test that
 * minted real tokens would be testing the library.
 */
export const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    switch (token) {
      case 'alice':
        return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
      case 'bob':
        return { kind: 'user', userId: BOB, handle: 'bob', roles: ['player'] }
      case 'admin':
        return { kind: 'user', userId: 'admin-1', handle: 'ops-jane', roles: ['admin'] }
      case 'svc-write':
        return { kind: 'service', service: 'hub', scopes: ['trade:read', 'trade:write'] }
      case 'svc-admin':
        return { kind: 'service', service: 'market', scopes: ['trade:admin', 'trade:read', 'trade:write'] }
      case 'svc-none':
        return { kind: 'service', service: 'nosy', scopes: ['other:read'] }
      case 'down':
        throw new VerifierUnavailableError('jwks unreachable')
      default:
        throw new TokenError('bad signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
    }
  },
}

/* ------------------------------------------------------------------ bars */

/**
 * A deterministic bar series.
 *
 * A closed form rather than a random walk: a fixture that used `Math.random()` would make every
 * failure of a determinism test ambiguous between "the engine is non-deterministic" and "the fixture
 * is". `shape` picks the price path, and every price is a scaled integer from the start.
 */
export function makeBars(options: {
  readonly count: number
  readonly startT?: number
  readonly widthSeconds?: number
  readonly basePrice?: number
  readonly shape?: 'rising' | 'falling' | 'sawtooth' | 'flat'
}): Bar[] {
  const count = options.count
  const width = options.widthSeconds ?? 3_600
  const startT = options.startT ?? 1_700_000_000 - (1_700_000_000 % width)
  const base = BigInt(options.basePrice ?? 30_000) * RATE_SCALE
  const shape = options.shape ?? 'rising'

  const bars: Bar[] = []
  for (let i = 0; i < count; i++) {
    let close: bigint
    switch (shape) {
      case 'rising':
        close = base + (base * BigInt(i)) / 200n
        break
      case 'falling':
        close = base - (base * BigInt(i)) / (BigInt(count) * 4n)
        break
      case 'sawtooth': {
        // A triangle wave: up for 20 bars, down for 20. Enough to make a crossover rule fire and a
        // grid fill, without any randomness.
        const phase = i % 40
        const leg = phase < 20 ? phase : 40 - phase
        close = base + (base * BigInt(leg)) / 100n
        break
      }
      default:
        close = base
    }
    const previous = bars[i - 1]
    const open = previous ? previous.c : close
    const high = (open > close ? open : close) + base / 500n
    const low = (open < close ? open : close) - base / 500n
    bars.push({ t: startT + i * width, o: open, h: high, l: low, c: close, v: BigInt(i + 1) * RATE_SCALE })
  }
  return bars
}

/* ------------------------------------------------------------------ the exchange */

/**
 * A market with small, round rules, for tests that are about matching rather than about decimals.
 *
 * `lotSize * tickSize` is a multiple of `10 ** baseDecimals` by construction, which is the
 * `markets_notional_exact` CHECK. That invariant is what makes `qty * price / baseUnit` exact, so a
 * fixture that broke it would make every fill in the suite throw `RangeError` instead of testing
 * anything — hence the defaults, and hence this note on the one field an overriding test is most
 * likely to change.
 *
 * The symbol is made unique per call, because these tests run against one database and a market is
 * unique on its symbol.
 */
export interface SeedMarketOptions {
  readonly symbol?: string
  readonly baseAsset?: string
  readonly quoteAsset?: string
  readonly baseDecimals?: number
  readonly quoteDecimals?: number
  readonly lotSize?: bigint
  readonly tickSize?: bigint
  readonly minNotional?: bigint
  readonly makerFeeBps?: number
  readonly takerFeeBps?: number
  readonly status?: string
  readonly bandBps?: number
}

let marketCounter = 0

export async function seedMarket(sql: Db, options: SeedMarketOptions = {}): Promise<string> {
  marketCounter += 1
  const symbol = options.symbol ?? `TST${marketCounter}-EMBER`
  const rows = await sql<{ id: string }[]>`
    insert into markets (
      symbol, base_asset, quote_asset, base_decimals, quote_decimals,
      lot_size, tick_size, min_notional, maker_fee_bps, taker_fee_bps, status, band_bps
    ) values (
      ${symbol},
      ${options.baseAsset ?? 'BTC'},
      ${options.quoteAsset ?? 'EMBER'},
      ${options.baseDecimals ?? 8},
      ${options.quoteDecimals ?? 18},
      ${(options.lotSize ?? 100_000n).toString()}::numeric,
      ${(options.tickSize ?? 1_000_000_000_000n).toString()}::numeric,
      ${(options.minNotional ?? 0n).toString()}::numeric,
      ${options.makerFeeBps ?? 0},
      ${options.takerFeeBps ?? 0},
      ${options.status ?? 'active'},
      ${options.bandBps ?? 10_000}
    )
    returning id
  `
  const id = rows[0]?.id
  if (!id) throw new Error('market insert returned no row')
  return id
}

/** Put spendable balance in a user's exchange account, the way a settled deposit would. */
export async function seedBalance(
  sql: Db,
  userId: string,
  asset: string,
  available: bigint,
): Promise<void> {
  await sql`
    insert into exchange_accounts (user_id, asset, available, held)
    values (${userId}, ${asset}, ${available.toString()}::numeric, 0)
    on conflict (user_id, asset)
      do update set available = exchange_accounts.available + excluded.available, updated_at = now()
  `
}

/**
 * Every unit of an asset the exchange is holding, across every account including the platform's.
 *
 * The conservation invariant is one SUM over one table precisely so that a test can state it in one
 * line: matching moves money between rows and must never change this number.
 */
export async function assetInCustody(sql: Db, asset: string): Promise<bigint> {
  const rows = await sql<{ total: string | null }[]>`
    select sum(available + held) as total from exchange_accounts where asset = ${asset}
  `
  const total = rows[0]?.total
  return total === null || total === undefined ? 0n : BigInt(total)
}

/** Insert a series and its bars, returning the series id. */
export async function seedSeries(
  sql: Db,
  bars: readonly Bar[],
  options: { symbol?: string; assetCode?: string; timeframe?: string } = {},
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into series (symbol, asset_code, timeframe, source)
    values (
      ${options.symbol ?? 'BTC-USD'}, ${options.assetCode ?? 'BTC'},
      ${options.timeframe ?? '1h'}, ${'fixture'}
    )
    on conflict (symbol, timeframe) do update set source = excluded.source
    returning id
  `
  const seriesId = rows[0]?.id
  if (!seriesId) throw new Error('series insert returned no row')
  if (bars.length > 0) {
    await sql`
      insert into bars ${sql(
        bars.map((bar) => ({
          series_id: seriesId,
          t: bar.t,
          o: bar.o.toString(),
          h: bar.h.toString(),
          l: bar.l.toString(),
          c: bar.c.toString(),
          v: bar.v.toString(),
        })),
      )}
      on conflict (series_id, t) do nothing
    `
  }
  return seriesId
}
