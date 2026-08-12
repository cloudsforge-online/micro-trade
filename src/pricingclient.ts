/**
 * Pricing, as this service uses it.
 *
 * Modelled on `micro-wallet/src/pricingclient.ts`, whose header states the two rules and why. They
 * matter more here than they do there, because wallet uses a rate to *display* a portfolio and this
 * service uses one to *move money*:
 *
 *   1. **A rate carries the instant it was observed.** A number with no timestamp cannot be shown to
 *      a user honestly and cannot be refused when it goes stale.
 *   2. **A rate that cannot be quoted is an ERROR, never a default.** A fallback rate is a rate at
 *      which somebody trades. There is no "last known price" here, no zero, and no cache that
 *      outlives its `asOf` — a bot that cannot be priced does not trade, which is what 07 §2 means
 *      by marking this a **hard** dependency: "a bot with no price does not trade".
 *
 * The rate is a **scaled integer**, `RATE_SCALE` (10^6) USD per whole coin, and never a float.
 * `contracts-chain`: "A float rate applied to an 18-decimal amount loses precision in the least
 * significant digits, which is exactly where a reconciliation drift shows up."
 *
 * ## Two things this client does that wallet's does not
 *
 * **It reads the spread-adjusted legs.** Wallet reads `usdScaled`, the mid-market price, which is
 * right for valuing a holding and wrong for settling a trade: pricing serves `usdBuyScaled` and
 * `usdSellScaled` precisely because a fill crosses the spread. Marking a position at the mid and
 * filling at the mid would make every backtest and every live bot quietly better than the money.
 *
 * **It re-checks the age itself.** Pricing already sets `usable: false` on a stale quote, and that
 * is the authority. This client checks anyway, against an injected clock, because the two failures
 * are different: `usable: false` is pricing telling us it knows the quote is bad, and a fresh-looking
 * quote with an old `quotedAt` is pricing being wrong or a response being replayed from something in
 * between. The second one is the one nobody notices.
 *
 * ## The route
 *
 * `GET /rates`. Verified against `micro-pricing/src/server.ts` — the board is returned whole
 * rather than filtered by asset, it is small and fixed, and asking for a subset would let the board
 * silently forget an asset exists. There is no `/quotes` and no `/v1/quotes`; the client that
 * assumed there was is the defect this comment exists to avoid repeating.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import { RATE_SCALE, type AssetCode } from '@cloudsforge/contracts-chain'
import type { LiveScope } from '@cloudsforge/contracts-auth'
import type { Clock } from './rng.ts'

/**
 * The scopes this service's token must carry to call pricing.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `ledgerclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the grant list, and identity
 * refuses to boot on a name the registry does not have or has deprecated.
 *
 * ── AND THIS GRANT IS WIDER THAN THE CALL SITE NEEDS ─────────────────────────────────────────
 *
 * `pricing:read` is registered and pricing enforces it, but the ONE route this client calls,
 * `GET /rates` (`pricing/src/server.ts`), is not gated at all — the board is public. So the
 * honest declaration is "nothing", and it is not written here yet for a reason belonging to the
 * derivation rather than to this service: `derive-grants.mjs` treats a module that presents a
 * credential and declares no scope as an undeclared gap and fails the estate build.
 * `@cloudsforge/contracts-auth` now exports `NO_SCOPES_REQUIRED` to make "nothing" a statement
 * rather than an absence, but the reader has not caught up — `derive-grants.mjs` matches
 * `= Object.freeze(` and would see `= NO_SCOPES_REQUIRED` as no declaration at all. Switching
 * this line today fails the estate build. micro-deploy first, then this. Narrow it once that
 * branch lands: an over-declaration is a real grant on a real token, and AD-05 says a token
 * carries the least it can. `micro-wallet`'s `PRICING_SCOPES` is the same line waiting on the
 * same change.
 */
export const PRICING_SCOPES: readonly LiveScope[] = Object.freeze(['pricing:read'])

/**
 * How old a quote may be before this service refuses to trade on it.
 *
 * Deliberately short, and deliberately shorter than a bar. A fill settles at the price the ledger is
 * told about, so a quote that has drifted is money moving at the wrong number — not a stale render.
 */
export const MAX_QUOTE_AGE_MS = 120_000

/**
 * No usable price. **Never caught and turned into a default.**
 *
 * Carries the reason pricing gave, because "no price" and "the quote is 400 seconds old" send an
 * operator to two different places.
 */
export class RateUnavailableError extends Error {
  readonly asset: string
  readonly reason: string
  constructor(asset: string, reason: string) {
    super(`no usable rate for ${asset}: ${reason}`)
    this.name = 'RateUnavailableError'
    this.asset = asset
    this.reason = reason
  }
}

/**
 * What KIND of number a quote is.
 *
 * Pricing's own vocabulary, and its database enforces it: `source text not null check (source in
 * ('market', 'administered'))` on `price_quotes` (`micro-pricing/src/migrations.ts`), where the
 * comment reads "'market' means a median of independent sources; 'administered' means an operator
 * typed it". The two are not interchangeable and the difference is not cosmetic — an administered
 * price is a number a person chose, it never decays at pricing, and a position marked against one is
 * worth what the operator says it is worth.
 *
 * `unknown` is here because this is a wire value. Pricing constrains its own column; this service
 * reads a JSON string over HTTP, and a word neither branch recognises must not be quietly filed
 * under `market` — that would report an administered mark as a market one, which is the exact defect
 * micro-org#368 is about, arrived at by a different route.
 */
export type QuoteSource = 'market' | 'administered' | 'unknown'

export function quoteSourceOf(raw: string): QuoteSource {
  return raw === 'market' || raw === 'administered' ? raw : 'unknown'
}

export interface Quote {
  readonly assetCode: AssetCode
  /** Mid-market USD per whole coin, scaled by `RATE_SCALE`. For MARKING a position. */
  readonly midScaled: bigint
  /** What a buyer pays, spread included. For a BUY fill. */
  readonly buyScaled: bigint
  /** What a seller receives, spread deducted. For a SELL fill. */
  readonly sellScaled: bigint
  /** When the underlying market observation was made — not when this response was built. */
  readonly asOf: string
  /** Narrowed at this boundary, so no caller has to know what strings pricing emits. */
  readonly source: QuoteSource
}

/** The subset of pricing's `RateView` this service actually reads. 14 §6: not the whole response. */
interface RawRate {
  readonly asset: string
  readonly usable: boolean
  readonly reason?: string
  readonly quotedAt: string | null
  readonly source: string
  readonly usdScaled: string | null
  readonly usdBuyScaled: string | null
  readonly usdSellScaled: string | null
  readonly rateScale?: string
}

export interface PricingClient {
  /** The price to settle a fill at, or a throw. There is no third outcome, on purpose. */
  quote(asset: AssetCode): Promise<Quote>
}

export interface PricingClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly clock: Clock
  readonly maxAgeMs?: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpPricingClient(options: PricingClientOptions): PricingClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'pricing',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const maxAgeMs = options.maxAgeMs ?? MAX_QUOTE_AGE_MS

  return {
    async quote(asset) {
      let board: readonly RawRate[]
      try {
        const body = await client.get<{ rates: readonly RawRate[] }>('/rates')
        board = body.rates ?? []
      } catch (err) {
        // Every failure mode collapses to one refusal, including a 4xx. A caller must not be able to
        // branch on "pricing said no" versus "pricing is down" and treat one of them as permission
        // to guess a number.
        const detail = err instanceof HttpError ? `pricing returned ${err.status}` : String(err)
        throw new RateUnavailableError(asset, detail)
      }

      const rate = board.find((r) => r.asset === asset)
      if (!rate) throw new RateUnavailableError(asset, 'not on the rate board')
      // `usable` is the field that matters. Pricing answers 200 for an asset whose rate is stale,
      // absent or below the smallest quotable unit, carrying the reason — so the caller must read
      // `usable` and not merely the presence of a number.
      if (!rate.usable) throw new RateUnavailableError(asset, rate.reason ?? 'pricing reports it unusable')
      if (rate.rateScale !== undefined && rate.rateScale !== RATE_SCALE.toString()) {
        // A scale skew is not a 500 — it is money credited at the wrong depth. Refusing is the only
        // safe reading of a board that disagrees with the contract package about what 10^6 means.
        throw new RateUnavailableError(asset, `rate scale is ${rate.rateScale}, expected ${RATE_SCALE}`)
      }
      if (!rate.quotedAt) throw new RateUnavailableError(asset, 'the quote carries no observation time')

      const asOf = Date.parse(rate.quotedAt)
      if (!Number.isFinite(asOf)) {
        throw new RateUnavailableError(asset, `unreadable observation time ${rate.quotedAt}`)
      }
      const ageMs = options.clock.now() - asOf
      if (ageMs > maxAgeMs) {
        throw new RateUnavailableError(
          asset,
          `the quote is ${Math.floor(ageMs / 1000)}s old, past the ${Math.floor(maxAgeMs / 1000)}s maximum`,
        )
      }

      // A usable rate that is missing a leg is not usable. Falling back to the mid here would be the
      // exact "fallback rate is a rate at which somebody trades" this file refuses.
      const mid = parseScaled(asset, 'usdScaled', rate.usdScaled)
      const buy = parseScaled(asset, 'usdBuyScaled', rate.usdBuyScaled)
      const sell = parseScaled(asset, 'usdSellScaled', rate.usdSellScaled)

      return {
        assetCode: asset,
        midScaled: mid,
        buyScaled: buy,
        sellScaled: sell,
        asOf: rate.quotedAt,
        source: quoteSourceOf(rate.source),
      }
    },
  }
}

function parseScaled(asset: string, field: string, value: string | null): bigint {
  if (value === null || value === undefined) throw new RateUnavailableError(asset, `${field} is absent`)
  if (!/^\d+$/.test(value)) throw new RateUnavailableError(asset, `${field} is not a scaled integer`)
  const parsed = BigInt(value)
  // Zero is a valuation, and a valuation of zero is a lie about a holding that exists.
  if (parsed <= 0n) throw new RateUnavailableError(asset, `${field} is not positive`)
  return parsed
}

/** The price a side of a fill settles at. One function, so the two legs cannot be mixed up twice. */
export function priceForSide(quote: Quote, side: 'buy' | 'sell'): bigint {
  return side === 'buy' ? quote.buyScaled : quote.sellScaled
}
