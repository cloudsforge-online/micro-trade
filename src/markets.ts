/**
 * Markets: the rules a symbol trades under, and the arithmetic derived from them.
 *
 * A market is reference data, not customer data. It is seeded by migration 10 and read on every
 * order, so it is read-mostly and locked-rarely — with one exception that is the whole reason this
 * file exports `lockMarket`.
 *
 * ## The market row is the exchange's lock
 *
 * `src/exchange.ts` takes `select … for update` on the market row before it reads the book, and
 * holds it until the transaction commits. That single line is what makes the matching engine's
 * determinism mean something: without it two orders can read the same book, both decide to take the
 * same resting quote, and both commit — which is a double fill against one maker, and the maker
 * finds out when their balance goes negative and the CHECK constraint refuses it.
 *
 * Locking the MARKET rather than the individual orders is deliberate. The set of rows an order
 * touches is not known until the book has been walked, so there is no lock order to take them in,
 * so there is a deadlock. One row per market is coarse and it is correct, and it means throughput
 * is per-market rather than per-exchange, which is the shape every real venue has.
 *
 * ## The price band
 *
 * `band_bps` either side of `reference_price` is the fat-finger control. It does two jobs: a limit
 * order priced outside the band is refused outright, and a market order is given the far edge of
 * the band as its protection price, so it stops rather than walking a thin book to the last quote.
 * A market with no reference price yet has no band — the first trades in a new market have nothing
 * to be measured against, and inventing a reference would be worse than admitting there is none.
 *
 * The reference is the last traded price, which is a deliberate choice with a known weakness: a
 * band anchored to the last trade can be WALKED, one band-width at a time, by a determined
 * participant. The alternative anchors are an oracle price this service does not have for every
 * pair and a time-weighted average this schema does not store. The band is sized (20% by default)
 * to catch a mistake rather than to stop a manipulation, and that is what it is described as.
 */

import { amountFrom } from './money.ts'
import type { MarketRules, Side } from './matching.ts'
import type { Db, Tx } from './outbox.ts'

export type MarketStatus = 'active' | 'post_only' | 'cancel_only' | 'halted'

export const MARKET_STATUSES: readonly MarketStatus[] = Object.freeze([
  'active',
  'post_only',
  'cancel_only',
  'halted',
])

export const isMarketStatus = (v: unknown): v is MarketStatus =>
  typeof v === 'string' && MARKET_STATUSES.includes(v as MarketStatus)

export interface Market {
  readonly id: string
  readonly symbol: string
  readonly baseAsset: string
  readonly quoteAsset: string
  readonly baseDecimals: number
  readonly quoteDecimals: number
  readonly lotSize: bigint
  readonly tickSize: bigint
  readonly minNotional: bigint
  readonly makerFeeBps: number
  readonly takerFeeBps: number
  readonly status: MarketStatus
  readonly bandBps: number
  readonly referencePrice: bigint | null
  readonly lastPrice: bigint | null
  readonly lastTradedAt: string | null
}

interface MarketRow {
  readonly id: string
  readonly symbol: string
  readonly base_asset: string
  readonly quote_asset: string
  readonly base_decimals: number
  readonly quote_decimals: number
  readonly lot_size: string
  readonly tick_size: string
  readonly min_notional: string
  readonly maker_fee_bps: number
  readonly taker_fee_bps: number
  readonly status: string
  readonly band_bps: number
  readonly reference_price: string | null
  readonly last_price: string | null
  readonly last_traded_at: Date | null
}

const COLUMNS = `id, symbol, base_asset, quote_asset, base_decimals, quote_decimals, lot_size,
  tick_size, min_notional, maker_fee_bps, taker_fee_bps, status, band_bps, reference_price,
  last_price, last_traded_at`

export const toMarket = (row: MarketRow): Market => ({
  id: row.id,
  symbol: row.symbol,
  baseAsset: row.base_asset,
  quoteAsset: row.quote_asset,
  baseDecimals: Number(row.base_decimals),
  quoteDecimals: Number(row.quote_decimals),
  lotSize: amountFrom(row.lot_size),
  tickSize: amountFrom(row.tick_size),
  minNotional: amountFrom(row.min_notional),
  makerFeeBps: Number(row.maker_fee_bps),
  takerFeeBps: Number(row.taker_fee_bps),
  status: row.status as MarketStatus,
  bandBps: Number(row.band_bps),
  referencePrice: row.reference_price === null ? null : amountFrom(row.reference_price),
  lastPrice: row.last_price === null ? null : amountFrom(row.last_price),
  lastTradedAt: row.last_traded_at === null ? null : row.last_traded_at.toISOString(),
})

/** `10 ** base_decimals` — the number of smallest base units in one whole one. */
export function baseUnitOf(market: Market): bigint {
  return 10n ** BigInt(market.baseDecimals)
}

/** The market's arithmetic, in the shape the engine takes. */
export function rulesOf(market: Market): MarketRules {
  return {
    baseUnit: baseUnitOf(market),
    lotSize: market.lotSize,
    tickSize: market.tickSize,
    minNotional: market.minNotional,
    makerFeeBps: market.makerFeeBps,
    takerFeeBps: market.takerFeeBps,
  }
}

export interface PriceBand {
  readonly low: bigint
  readonly high: bigint
}

/**
 * The acceptable price range, or `null` when the market has never traded.
 *
 * Rounded OUTWARD on both edges and then snapped to a tick, so the band never excludes a price a
 * customer could reasonably have meant. An inward-rounded band rejects the exact edge it advertises,
 * which reads as a bug to everyone who hits it.
 */
export function priceBand(market: Market): PriceBand | null {
  const reference = market.referencePrice
  if (reference === null || reference <= 0n) return null
  const span = BigInt(market.bandBps)
  const lowRaw = (reference * (10_000n - span)) / 10_000n
  const highRaw = (reference * (10_000n + span) + 9_999n) / 10_000n
  const low = (lowRaw / market.tickSize) * market.tickSize
  const high = ((highRaw + market.tickSize - 1n) / market.tickSize) * market.tickSize
  return { low: low < market.tickSize ? market.tickSize : low, high }
}

/**
 * The worst price a market order on `side` will accept, or `null` when there is no band.
 *
 * A buyer's protection is the top of the band and a seller's is the bottom, because those are the
 * directions in which each of them can be hurt.
 */
export function protectionPriceFor(market: Market, side: Side): bigint | null {
  const band = priceBand(market)
  if (!band) return null
  return side === 'buy' ? band.high : band.low
}

export async function listMarkets(sql: Db): Promise<readonly Market[]> {
  const rows = await sql<MarketRow[]>`
    select ${sql.unsafe(COLUMNS)} from markets order by symbol asc
  `
  return rows.map(toMarket)
}

export async function getMarket(sql: Db | Tx, id: string): Promise<Market | null> {
  const rows = await sql<MarketRow[]>`select ${sql.unsafe(COLUMNS)} from markets where id = ${id}`
  const row = rows[0]
  return row ? toMarket(row) : null
}

/**
 * Look a market up by the symbol a human typed.
 *
 * Case-folded, because `btc-ember` and `BTC-EMBER` are the same market and a customer who types the
 * first and is told the market does not exist has been told something false.
 */
export async function getMarketBySymbol(sql: Db | Tx, symbol: string): Promise<Market | null> {
  const rows = await sql<MarketRow[]>`
    select ${sql.unsafe(COLUMNS)} from markets where upper(symbol) = upper(${symbol})
  `
  const row = rows[0]
  return row ? toMarket(row) : null
}

/**
 * Take the market's lock and read it back inside the transaction.
 *
 * Everything the caller then reads about this market — the book, the resting orders, the balances
 * they escrow against — is serialised behind this line. See the header for why it is the market row
 * and not the orders.
 */
export async function lockMarket(tx: Tx, id: string): Promise<Market | null> {
  const rows = await tx<MarketRow[]>`
    select ${tx.unsafe(COLUMNS)} from markets where id = ${id} for update
  `
  const row = rows[0]
  return row ? toMarket(row) : null
}

/**
 * Record the price a trade printed at.
 *
 * `reference_price` follows `last_price`, so the band tracks the market. Both move in one statement
 * with the lock still held, so no reader can observe a market whose last price and band disagree.
 */
export async function recordLastPrice(tx: Tx, marketId: string, price: bigint): Promise<void> {
  await tx`
    update markets
       set last_price      = ${price.toString()}::numeric,
           reference_price = ${price.toString()}::numeric,
           last_traded_at  = now(),
           updated_at      = now()
     where id = ${marketId}
  `
}

/** Change what a market will accept. Halting is the only thing that stops an order mid-flight. */
export async function setMarketStatus(sql: Db, id: string, status: MarketStatus): Promise<Market | null> {
  const rows = await sql<MarketRow[]>`
    update markets set status = ${status}, updated_at = now()
     where id = ${id}
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toMarket(row) : null
}
