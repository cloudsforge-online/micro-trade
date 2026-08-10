/**
 * What the market looks like from outside: the tape, the ticker, and candles.
 *
 * Everything here is DERIVED from `trades` on read. Nothing is cached and no summary is stored, and
 * that is a decision rather than an omission: a stored 24-hour volume is a number that can disagree
 * with the trades it came from, and the first time it does, nobody can tell which of the two is
 * wrong. Deriving costs an index scan over a day of one market's trades, which `trades_market_idx`
 * serves; if that ever stops being cheap the answer is a materialised view with a refresh job, not a
 * counter maintained by hand in the matching path.
 *
 * ## What is public and what is not
 *
 * The tape publishes price, quantity and the TAKER's side, and nothing else. No account ids, no
 * order ids, no fees. Which side was the aggressor is genuinely public information — it is what
 * every venue prints and what a reader needs to tell a buy from a sell — and the two counterparties
 * are not. The caller's OWN fills come from a separate route that carries the fee and the order id.
 *
 * "Public" here means public in CONTENT, not in access: `src/server.ts` still asks for a token on
 * the tape, unlike the strategy catalogue beside it. The reason is `TRADE_EXCHANGE_ENABLED` and R-54
 * — a venue operating under a legal question mark should not be publishing an anonymous, scrapable
 * order flow feed — and the practical one is that the rate limiter's subject is the authenticated
 * user (`src/ratelimit.ts`), so an unauthenticated read is a read nothing can meter.
 */

import { amountFrom } from './money.ts'
import { toTrade, TRADE_COLUMNS, type TradeRecord } from './exchange.ts'
import type { Db } from './outbox.ts'

/** One line of the public tape. Deliberately smaller than a `TradeRecord`. */
export interface PublicTrade {
  readonly id: string
  readonly seq: bigint
  readonly price: bigint
  readonly qty: bigint
  readonly quoteQty: bigint
  /** Which side crossed the spread. The maker took the other one. */
  readonly takerSide: 'buy' | 'sell'
  readonly at: string
}

export async function recentTrades(sql: Db, marketId: string, limit: number): Promise<readonly PublicTrade[]> {
  const rows = await sql<
    { id: string; seq: string | number; price: string; qty: string; quote_qty: string; taker_side: string; created_at: Date }[]
  >`
    select id, seq, price, qty, quote_qty, taker_side, created_at
      from trades where market_id = ${marketId}
     order by seq desc limit ${limit}
  `
  return rows.map((row) => ({
    id: row.id,
    seq: BigInt(row.seq),
    price: amountFrom(row.price),
    qty: amountFrom(row.qty),
    quoteQty: amountFrom(row.quote_qty),
    takerSide: row.taker_side as 'buy' | 'sell',
    at: row.created_at.toISOString(),
  }))
}

/**
 * The caller's own trades, with the parts of them that are theirs alone.
 *
 * A user appears on a trade as taker or maker, so the query is an OR over both columns and the role
 * is derived per row. The fee returned is the one THIS user paid, which is why it cannot come from a
 * single column: on one trade the taker fee is one customer's and the maker fee is another's.
 */
export interface OwnFill {
  readonly tradeId: string
  readonly orderId: string
  readonly marketId: string
  readonly side: 'buy' | 'sell'
  readonly role: 'taker' | 'maker'
  readonly price: bigint
  readonly qty: bigint
  readonly quoteQty: bigint
  readonly fee: bigint
  readonly feeAsset: 'base' | 'quote'
  readonly at: string
}

/**
 * One trade, as it looks to one of its two counterparties — or `null` if they are neither.
 *
 * Pure, and separate from the query, because `src/server.ts` needs exactly this projection for the
 * trades a placement just printed and there must not be two spellings of "which fee was mine". A
 * placement can print trades belonging to OTHER customers — a stop of theirs that the new price
 * fired — and the `null` return is what keeps those out of the placer's response rather than a
 * filter the caller has to remember to write.
 */
export function ownFillOf(userId: string, trade: TradeRecord): OwnFill | null {
  const taker = trade.takerUserId === userId
  if (!taker && trade.makerUserId !== userId) return null
  const side: 'buy' | 'sell' = taker ? trade.takerSide : trade.takerSide === 'buy' ? 'sell' : 'buy'
  return {
    tradeId: trade.id,
    orderId: taker ? trade.takerOrderId : trade.makerOrderId,
    marketId: trade.marketId,
    side,
    role: taker ? 'taker' : 'maker',
    price: trade.price,
    qty: trade.qty,
    quoteQty: trade.quoteQty,
    fee: taker ? trade.takerFee : trade.makerFee,
    feeAsset: taker ? trade.takerFeeAsset : trade.makerFeeAsset,
    at: trade.createdAt,
  }
}

export async function listOwnFills(
  sql: Db,
  userId: string,
  marketId: string | null,
  limit: number,
): Promise<readonly OwnFill[]> {
  const rows = await sql<Parameters<typeof toTrade>[0][]>`
    select ${sql.unsafe(TRADE_COLUMNS)} from trades
     where (taker_user_id = ${userId} or maker_user_id = ${userId})
       and (${marketId}::uuid is null or market_id = ${marketId}::uuid)
     order by seq desc limit ${limit}
  `
  // The `null` case cannot arise here — the WHERE clause already named the user on one side or the
  // other — but it is filtered rather than asserted away, because an assertion would be a second
  // statement of the same fact that could stop being true if the query changed.
  return rows
    .map(toTrade)
    .map((trade) => ownFillOf(userId, trade))
    .filter((fill): fill is OwnFill => fill !== null)
}

/**
 * A market's last day.
 *
 * `open` is the first trade at or after the window opened and `last` is the most recent trade of all
 * time — not of the window. That difference matters on a quiet market: a pair that has not traded
 * today still has a last price, and reporting `null` because the window is empty would blank out
 * every screen showing it. `change` is `null` rather than zero when there is no open, because "did
 * not move" and "nothing to compare against" are different facts.
 */
export interface Ticker {
  readonly marketId: string
  readonly last: bigint | null
  readonly open: bigint | null
  readonly high: bigint | null
  readonly low: bigint | null
  readonly baseVolume: bigint
  readonly quoteVolume: bigint
  readonly trades: number
  /** Basis points, signed. `null` when the window carried no trade to open against. */
  readonly changeBps: number | null
}

export async function ticker(sql: Db, marketId: string, nowMs: number): Promise<Ticker> {
  const since = new Date(nowMs - 24 * 60 * 60 * 1_000)
  const rows = await sql<
    { high: string | null; low: string | null; base_volume: string | null; quote_volume: string | null; trades: string | number }[]
  >`
    select max(price) as high, min(price) as low,
           sum(qty) as base_volume, sum(quote_qty) as quote_volume,
           count(*) as trades
      from trades where market_id = ${marketId} and created_at >= ${since}
  `
  const window = rows[0]
  const opens = await sql<{ price: string }[]>`
    select price from trades where market_id = ${marketId} and created_at >= ${since}
     order by seq asc limit 1
  `
  const lasts = await sql<{ price: string }[]>`
    select price from trades where market_id = ${marketId} order by seq desc limit 1
  `
  const open = opens[0] ? amountFrom(opens[0].price) : null
  const last = lasts[0] ? amountFrom(lasts[0].price) : null
  const changeBps =
    open !== null && open > 0n && last !== null ? Number(((last - open) * 10_000n) / open) : null
  return {
    marketId,
    last,
    open,
    high: window?.high ? amountFrom(window.high) : null,
    low: window?.low ? amountFrom(window.low) : null,
    baseVolume: window?.base_volume ? amountFrom(window.base_volume) : 0n,
    quoteVolume: window?.quote_volume ? amountFrom(window.quote_volume) : 0n,
    trades: Number(window?.trades ?? 0),
    changeBps,
  }
}

/** The candle widths the chart offers. Minutes, because every one of these divides an hour. */
export const CANDLE_INTERVALS = Object.freeze({
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
} as const)

export type CandleInterval = keyof typeof CANDLE_INTERVALS

export const isCandleInterval = (v: unknown): v is CandleInterval =>
  typeof v === 'string' && Object.hasOwn(CANDLE_INTERVALS, v)

export interface Candle {
  /** Bucket start, epoch seconds. */
  readonly t: number
  readonly open: bigint
  readonly high: bigint
  readonly low: bigint
  readonly close: bigint
  readonly baseVolume: bigint
  readonly quoteVolume: bigint
  readonly trades: number
}

/**
 * OHLCV, bucketed by `date_bin`.
 *
 * Open and close are picked with `first_value`/`last_value` over the trade SEQUENCE and not over
 * the timestamp, because two trades in one bucket can share a timestamp to the microsecond and only
 * the sequence orders them — the same reason the book ranks on `sequence` rather than on `now()`.
 * Empty buckets are simply absent rather than forward-filled: a chart that draws a flat line
 * through a period with no trading is stating something that did not happen.
 */
export async function candles(
  sql: Db,
  marketId: string,
  interval: CandleInterval,
  limit: number,
): Promise<readonly Candle[]> {
  const seconds = CANDLE_INTERVALS[interval]
  const rows = await sql<
    { bucket: Date; open: string; high: string; low: string; close: string; base_volume: string; quote_volume: string; trades: string | number }[]
  >`
    with binned as (
      select date_bin(make_interval(secs => ${seconds}), created_at, timestamptz 'epoch') as bucket,
             seq, price, qty, quote_qty
        from trades where market_id = ${marketId}
    )
    select bucket,
           (array_agg(price order by seq asc))[1]  as open,
           max(price)                              as high,
           min(price)                              as low,
           (array_agg(price order by seq desc))[1] as close,
           sum(qty)                                as base_volume,
           sum(quote_qty)                          as quote_volume,
           count(*)                                as trades
      from binned
     group by bucket
     order by bucket desc
     limit ${limit}
  `
  return rows
    .map((row) => ({
      t: Math.floor(row.bucket.getTime() / 1_000),
      open: amountFrom(row.open),
      high: amountFrom(row.high),
      low: amountFrom(row.low),
      close: amountFrom(row.close),
      baseVolume: amountFrom(row.base_volume),
      quoteVolume: amountFrom(row.quote_volume),
      trades: Number(row.trades),
    }))
    .reverse()
}

/** One trade by id, for the rare direct lookup. Public shape only. */
export async function getTrade(sql: Db, id: string): Promise<TradeRecord | null> {
  const rows = await sql<Parameters<typeof toTrade>[0][]>`
    select ${sql.unsafe(TRADE_COLUMNS)} from trades where id = ${id}
  `
  const row = rows[0]
  return row ? toTrade(row) : null
}
