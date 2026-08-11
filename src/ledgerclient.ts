/**
 * The ledger, as this service uses it.
 *
 * **This service holds no balance.** 04 §11: "no 'user balance' column anywhere outside the ledger's
 * projection … A cached balance in a product database is the bug that made Crucible's bot state
 * diverge from Pay's." That sentence names this repository's predecessor by defect, so it is worth
 * being precise about what `bots.cash` and `bots.position` are:
 *
 *   * For a **paper** bot they are a simulation. No ledger call is ever made and nothing they say is
 *     a claim about money.
 *   * For a **live** bot they are this service's record of what it asked for and what the ledger
 *     told it happened. They are moved only by applying a fill whose `entry_id` came back from the
 *     ledger, so every cent of movement has a journal entry behind it. They are a **mirror with a
 *     receipt**, not a balance — and when the two disagree, the ledger is right and this service is
 *     wrong.
 *
 * ## THIS FILE STILL SAYS `SHARD`, AND IT IS THE ONLY ONE THAT MAY
 *
 * micro-org#418 re-denominated micro-trade to US cents. Every amount above and every field this
 * service puts on its OWN wire is a cent count. **The `assetCode` literals below are not renamed
 * and must not be**, for a reason that outlives the retirement:
 *
 * An asset code here names an account in ANOTHER service's chart of accounts. Live capital sits in
 * `user:<id> available SHARD` inside micro-ledger, where 69,000 real units are held for real
 * people. Renaming the literal would not rename the account — it would address a different one, and
 * a reservation or a fill posted against an account holding nothing either fails or moves the wrong
 * money. That is a false statement about money, which is exactly the trade micro-mint refused from
 * the other side of its own wire: `mint-web`'s `charge()` still prints SHARD for a debit
 * micro-ledger really recorded in SHARD, and says so in as many words.
 *
 * The amounts are cents and the asset is SHARD, and both are true at once because the peg is
 * exactly one to one — `SHARDS_PER_USD` is `100n`, SHARD carries `decimals: 0`. That is the shape
 * mint landed on too: `price_usd_cents` for the amount, `charge_asset_code` for the asset.
 *
 * micro-ledger expects this. Its `retired_asset_guard` migration refuses retired assets only for
 * ACQUISITION kinds, and deliberately leaves `trading_fill` and `performance_fee` legal — naming
 * micro-trade among the services that must migrate before it can tighten. Moving those balances is
 * a cross-service money migration over live accounts. It is not a rename, and it is not this change.
 *
 * ## The three things trade asks the ledger for
 *
 *   1. **A reservation**, when a live bot starts. Capital committed to a bot must stop being
 *      spendable elsewhere, and 07 §6 says a caller holds "the reservation *id* only" — never a
 *      copy of the amount as a balance. `POST /reservations`.
 *   2. **A fill posting**, when a bot trades. `POST /entries`, kind `trading_fill`.
 *   3. **A fee posting**, when a performance fee is collected. `POST /entries`, kind
 *      `performance_fee`.
 *
 * Both kinds are from the closed set in 04 §2.2, and both are the ones that set aside for this
 * service. There is no fourth thing: **the ledger is a sink** (07 §1) and it calls nothing back, so
 * a money write is one transaction rather than a saga.
 *
 * ## The failure taxonomy is the whole safety argument
 *
 * `HttpError.peerDecided` is the discriminator. A **4xx means the ledger looked at the request and
 * said no**, which is a permanent fact about it: nothing moved and nothing will, so the caller may
 * retire the attempt. **Everything else — a 5xx, a timeout, a reset socket — means we do not know**,
 * and the only safe response is to retry under the same idempotency key.
 *
 * Getting that backwards is how the frozen service's fee loop double-billed people, and its own
 * comment says so at `crucible/services/crucible/src/fees.ts`: an unknown outcome written off
 * as a refusal "restored the whole debt to `feeOwed` … The next pass then re-billed the identical
 * arrears under a BRAND NEW key … One lost answer, two debits."
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import { userSubject } from '@cloudsforge/contracts-money'
import type { AccountSubject, Actor, EntryKind, LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call the ledger.
 *
 * `readonly LiveScope[]`, not `readonly string[]`. This is an OUTBOUND demand — what trade
 * presents to the ledger — and that direction had never been checked by anything.
 * `service-ci.yml`'s scope audit reads a repository's INBOUND route gates, which is how two
 * services in this estate came to declare scopes that do not exist (`policy:evaluate`,
 * `custody:address`) with nothing noticing. `micro-deploy`'s `derive-grants.mjs` reads this
 * constant into `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list against the
 * registry at import and REFUSES TO BOOT on an unknown name — so a typo here is not one failed
 * ledger call, it is no token minting for the whole estate.
 *
 * `LiveScope` rather than `Scope` because `Scope` is `keyof typeof SCOPES` — every registered key,
 * DEPRECATED ones included — and identity will not mint a deprecated scope either. `LiveScope =
 * Exclude<Scope, DeprecatedScope>`, with `DeprecatedScope` computed FROM `SCOPES` by a conditional
 * type over the `deprecated` field rather than hand-listed, so it cannot drift from the registry
 * (`contracts/packages/auth/src/index.ts`). Reading a token stays wide — one may arrive
 * carrying a scope that has since died — and demanding is narrow. This is demanding.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze([
  'ledger:post',
  'ledger:reserve',
  // Read is here for exactly one caller: `collect` in src/fees.ts, which must ask what a wallet
  // holds before lowering a charge to fit it. It is NOT a balance this service stores — the answer
  // is used once, inside one settlement pass, and discarded. 04 §11 forbids the other thing.
  'ledger:read',
])

/** The ledger decided, and decided no. Nothing moved. Never retried with the same request. */
export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

/** The outcome is UNKNOWN. Retry with the same idempotency key; do not record a refusal. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

/**
 * An identical request under this key is committing inside the ledger right now.
 *
 * Not a failure and not a refusal — "ask again in a moment", and the answer will be the original
 * one. A caller that records a debt here records it for a charge that is about to succeed.
 */
export class LedgerInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight at the ledger')
    this.name = 'LedgerInFlightError'
  }
}

/**
 * An account at the ledger.
 *
 * ## `subject` is `AccountSubject`, and that is the durable half of micro-org#372
 *
 * It was `string`. `transferPostings` spelled the escrow leg `subject: 'exchange'` from the day the
 * order book shipped, the estate's grammar had no such subject, and every posting the function made
 * would have died at `parseAccountSubject` inside the ledger's `ensureAccount` — in both
 * directions, for every asset, after `bookTransfer` had already debited the customer's available
 * balance in its own transaction. It surfaced as a red `estate-ci` sweep and not as a type error,
 * because `string` is what a subject was declared to be here.
 *
 * Registering `exchange` in `contracts-money` and importing `EXCHANGE` fixed THAT line. It did not
 * fix the property that let it through: five more subject literals live in this file and in
 * `bots.ts`, and every one of them was equally free to be wrong. Naming the contract's own union
 * here is what makes the next invented subject a `pnpm typecheck` failure rather than a posting
 * that dies at the far end of the estate. The union admits `user:${string}` and the four
 * singletons, so no correct call site had to change.
 *
 * Measured 2026-08-11: zero rows in mainnet `trade.exchange_transfers` and no `exchange`-subject
 * account in the mainnet ledger, so nothing was ever posted under the wrong spelling.
 */
export interface AccountRef {
  readonly subject: AccountSubject
  readonly assetCode: LedgerAssetCode
  readonly purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense'
  readonly type: 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing'
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface ReserveRequest {
  /** Same union as `AccountRef.subject`, for the same reason — a reservation names an account too. */
  readonly subject: AccountSubject
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
}

export interface Reservation {
  readonly reservationId: string
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
  reserve(request: ReserveRequest): Promise<Reservation>
  release(reservationId: string, request: Omit<ReserveRequest, 'subject' | 'assetCode' | 'amount'>): Promise<PostedEntry>
  /**
   * Spendable US cents, right now, for one settlement decision.
   *
   * Reads the SHARD wallet and returns a cent count. Both halves of that sentence are true — see
   * the header: the peg is 1:1, and the asset code is micro-ledger's rather than this service's.
   *
   * **Read and discarded.** The answer is never written down: a stored balance is the thing 04 §11
   * forbids, and it would be stale the moment it landed. `null` means the ledger would not say —
   * which a caller must treat as "do not know", never as zero, because zero is a decision.
   */
  availableUsdCents(userId: string): Promise<bigint | null>
}

/* ------------------------------------------------------------------ the postings
 *
 * `userSubject` is the CONTRACT's, imported above — micro-org#372's second half. This file and
 * `transfers.ts` each carried a local `(id) => \`user:${id}\`` returning `string`. Two hand-rolled
 * spellings of a grammar that lives somewhere else is exactly the shape that put
 * `subject: 'exchange'` on the wire, and the imported one additionally REFUSES an id containing
 * `:` or `|` — which `accountKey` joins on, so an id carrying one would let two distinct accounts
 * produce a single key. That is the quietest possible way to merge two customers' balances, and no
 * local one-liner has ever checked for it.
 */

/**
 * The postings that settle a fill.
 *
 * A fill is a **conversion between two assets**, so it cannot be two postings: `balanceEntry`
 * requires debits to equal credits *per asset*, and Shards leaving a wallet do not balance against
 * coin arriving in it. The clearing account is what makes both legs balance without inventing a
 * counterparty:
 *
 *   buy   user SHARD available  → clearing        (Shards balance)
 *         clearing              → user ASSET      (the asset balances)
 *         user SHARD available  → platform fees   (the fee, in Shards)
 *
 * and the mirror for a sell. The fee is part of the SAME entry rather than a second one, because a
 * fee that can post without its fill is a fee that will, and reconciling those two after the fact is
 * a job nobody has.
 */
export function fillPostings(input: {
  readonly userId: string
  readonly asset: AssetCode
  readonly side: 'buy' | 'sell'
  /** Shards moved, always positive — the direction is carried by `side`. */
  readonly notionalUsdCents: bigint
  /** Base-asset smallest units moved, always positive. */
  readonly units: bigint
  readonly feeUsdCents: bigint
}): readonly PostingRequest[] {
  const subject = userSubject(input.userId)
  const shardWallet: AccountRef = { subject, assetCode: 'SHARD', purpose: 'available', type: 'liability' }
  const assetWallet: AccountRef = { subject, assetCode: input.asset, purpose: 'available', type: 'liability' }
  const shardClearing: AccountRef = { subject: 'clearing', assetCode: 'SHARD', purpose: 'suspense', type: 'clearing' }
  const assetClearing: AccountRef = { subject: 'clearing', assetCode: input.asset, purpose: 'suspense', type: 'clearing' }
  const platformFees: AccountRef = { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' }

  const postings: PostingRequest[] =
    input.side === 'buy'
      ? [
          { account: shardWallet, direction: 'debit', amount: input.notionalUsdCents, assetCode: 'SHARD', sequence: 0 },
          { account: shardClearing, direction: 'credit', amount: input.notionalUsdCents, assetCode: 'SHARD', sequence: 1 },
          { account: assetClearing, direction: 'debit', amount: input.units, assetCode: input.asset, sequence: 2 },
          { account: assetWallet, direction: 'credit', amount: input.units, assetCode: input.asset, sequence: 3 },
        ]
      : [
          { account: assetWallet, direction: 'debit', amount: input.units, assetCode: input.asset, sequence: 0 },
          { account: assetClearing, direction: 'credit', amount: input.units, assetCode: input.asset, sequence: 1 },
          { account: shardClearing, direction: 'debit', amount: input.notionalUsdCents, assetCode: 'SHARD', sequence: 2 },
          { account: shardWallet, direction: 'credit', amount: input.notionalUsdCents, assetCode: 'SHARD', sequence: 3 },
        ]

  if (input.feeUsdCents > 0n) {
    postings.push(
      { account: shardWallet, direction: 'debit', amount: input.feeUsdCents, assetCode: 'SHARD', sequence: 4 },
      { account: platformFees, direction: 'credit', amount: input.feeUsdCents, assetCode: 'SHARD', sequence: 5 },
    )
  }
  return postings
}

/**
 * The two postings that collect a performance fee.
 *
 * Charged against the user's wallet, **not deducted from the bot**. Deducting from the bot would
 * silently shrink the position the user chose, and would make the equity curve a function of our
 * billing. The frozen service makes the same choice for the same reason
 * (`crucible/services/crucible/src/fees.ts`) and it is carried forward.
 */
export function performanceFeePostings(input: {
  readonly userId: string
  readonly amountUsdCents: bigint
}): readonly PostingRequest[] {
  return [
    {
      account: { subject: userSubject(input.userId), assetCode: 'SHARD', purpose: 'available', type: 'liability' },
      direction: 'debit',
      amount: input.amountUsdCents,
      assetCode: 'SHARD',
      sequence: 0,
    },
    {
      account: { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' },
      direction: 'credit',
      amount: input.amountUsdCents,
      assetCode: 'SHARD',
      sequence: 1,
    },
  ]
}

/* ------------------------------------------------------------------ derived keys */

/**
 * The key one fill posts under, for ever.
 *
 * **Derived from the fill row's id**, which is itself unique per `(bot, bar, side)`. Two independent
 * defences that fail in the same direction: the unique index refuses a second row for the same bar,
 * and the derived key means even a second attempt at the SAME row replays rather than posting again.
 */
export const fillIdempotencyKey = (fillId: string): string => `trade:fill:${fillId}`

/**
 * The key one settlement charges under, for ever.
 *
 * Derived from `(botId, period)` rather than from a random row id. This is the fix for the defect
 * `micro-org`'s own testing strategy names at 14 §5: the frozen key is
 * `crucible:settlement:<randomUUID>` (`crucible/services/crucible/src/store.ts` +
 * `clients/pay.ts`), so two attempts at one settlement produce two different keys and the
 * upstream honours both. Deriving it from the period means the second attempt cannot invent a new
 * one, and `fee_settlements_bot_period_uniq` means it cannot get a row to derive one from either.
 */
export const settlementIdempotencyKey = (botId: string, period: bigint): string =>
  `trade:settlement:${botId}:${period}`

/** The key a bot's capital is reserved under. Derived from the bot, so a retried start reserves once. */
export const allocationIdempotencyKey = (botId: string): string => `trade:allocation:${botId}`

/* ------------------------------------------------------------------ the client */

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    // `money-write` (07 §2): **no automatic retry**. The caller re-submits under the same key when it
    // is ready to, which is a decision about money and does not belong to a transport library.
    defaultRetries: 0,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const post = async (path: string, body: Record<string, unknown>, key: string): Promise<{ entry: RawEntry; replayed: boolean; reservationId?: string }> => {
    try {
      return await client.request<{ entry: RawEntry; replayed: boolean; reservationId?: string }>(path, {
        method: 'POST',
        body,
        // The key is in the body AND on the request, and both matter. In the body it is what the
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at all.
        idempotencyKey: key,
      })
    } catch (err) {
      throw translate(err)
    }
  }

  return {
    async postEntry(request) {
      const body = await post(
        '/entries',
        {
          kind: request.kind,
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
          postings: request.postings.map((posting) => ({
            direction: posting.direction,
            // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE 754
            // double, and a large amount does not survive one — it does not fail either, it comes
            // back subtly wrong.
            amount: posting.amount.toString(),
            assetCode: posting.assetCode,
            sequence: posting.sequence,
            account: posting.account,
          })),
        },
        request.idempotencyKey,
      )
      return { id: body.entry.id, kind: body.entry.kind, recordedAt: body.entry.recordedAt, replayed: body.replayed }
    },

    async reserve(request) {
      const body = await post(
        '/reservations',
        {
          subject: request.subject,
          assetCode: request.assetCode,
          amount: request.amount.toString(),
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
        },
        request.idempotencyKey,
      )
      return { reservationId: body.reservationId ?? body.entry.id, replayed: body.replayed }
    },

    async release(reservationId, request) {
      const body = await post(
        `/reservations/${encodeURIComponent(reservationId)}/release`,
        {
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
        },
        request.idempotencyKey,
      )
      return { id: body.entry.id, kind: body.entry.kind, recordedAt: body.entry.recordedAt, replayed: body.replayed }
    },

    async availableUsdCents(userId) {
      try {
        const subject = encodeURIComponent(`user:${userId}`)
        const body = await client.get<{ balances: readonly RawBalance[] }>(`/accounts/${subject}/balances`)
        const row = (body.balances ?? []).find((b) => b.assetCode === 'SHARD' && b.purpose === 'available')
        if (!row || !/^-?\d+$/.test(row.amount)) return null
        const amount = BigInt(row.amount)
        return amount < 0n ? 0n : amount
      } catch {
        // A read this service cannot get is "do not know", and every caller of it treats that as a
        // reason to DEFER rather than to charge. Returning 0n here would turn an outage into a
        // written-off debt.
        return null
      }
    },
  }
}

interface RawBalance {
  readonly assetCode: string
  readonly purpose: string
  readonly amount: string
}

/**
 * What the answer proves about where the money is.
 *
 * `idempotency_in_flight` is pulled out of the 409s deliberately. The ledger answers 409 for
 * insufficient funds AND for both idempotency conditions, so the status alone does not identify the
 * cause — a distinction the frozen client also had to make
 * (`crucible/services/crucible/src/clients/pay.ts`). An in-flight duplicate is a retry-later,
 * not a failure, and must not be reported as one.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError) {
    const parsed = parseError(err.body)
    if (parsed.code === 'idempotency_in_flight') return new LedgerInFlightError()
    if (err.peerDecided) return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError || err instanceof LedgerInFlightError) {
    return err
  }
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
