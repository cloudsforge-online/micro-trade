/**
 * The exchange: placement, matching, cancellation, triggers and expiry.
 *
 * `src/matching.ts` decides. This file is the part that holds the lock, reads the book, hands it to
 * the engine, and writes down what the engine said — and it is deliberately the only place in the
 * service that writes an order row or moves an exchange balance, because those two things must
 * always happen together and a second caller that did one without the other would be undetectable.
 *
 * ## The shape of a placement
 *
 *   1. Validate against the market's rules, twice: once before the transaction so an obviously bad
 *      order costs nothing, and once against the row read UNDER THE LOCK, because a market can be
 *      halted between the two.
 *   2. `select … for update` on the market row. Everything after this line is serialised per
 *      market. See `src/markets.ts` for why the lock is the market and not the orders.
 *   3. Reserve the escrow. Before the order exists, so an order can never exist without its money.
 *   4. Insert the order. This is where `sequence` is drawn, so arrival order is lock order.
 *   5. Match, apply, settle balances, print trades, release what was over-reserved.
 *   6. Fire any stop orders the new price triggered, and match those too, up to a bound.
 *
 * All six are one transaction. There is no state in which the escrow moved and the order did not,
 * or a trade printed and a balance did not follow it.
 *
 * ## Why the escrow is exact
 *
 * A buyer reserves `qty * price / 10^base_decimals` quote and nothing more; a seller reserves `qty`
 * base and nothing more. There is no fee term, because the fee is taken from the asset each side
 * RECEIVES (`src/matching.ts` explains why). A buy that fills below its limit has over-reserved, and
 * the difference is released in the same transaction as the fill — the customer sees the price
 * improvement as money returning to `available`, not as a rounding they have to ask about.
 *
 * ## What this file will not do
 *
 * It will not touch the ledger. A match moves money between two rows of `exchange_accounts` and
 * nothing else; the ledger sees a deposit and a withdrawal (`src/transfers.ts`) and nothing in
 * between. That is what keeps a fill to a single local transaction instead of a distributed one
 * inside a held lock.
 */

import { amountFrom } from './money.ts'
import {
  aggregateDepth,
  matchOrder,
  notionalOf,
  rankBook,
  type MatchPlan,
  type OrderType,
  type Side,
  type StpMode,
  type TakerOrder,
  type TimeInForce,
} from './matching.ts'
import {
  PLATFORM_ACCOUNT_ID,
  credit,
  hold,
  release,
  spendHeld,
} from './accounts.ts'
import {
  baseUnitOf,
  lockMarket,
  protectionPriceFor,
  priceBand,
  recordLastPrice,
  rulesOf,
  type Market,
} from './markets.ts'
import {
  ORDER_COLUMNS,
  getOrder,
  loadBook,
  recordOrderEvent,
  toOrder,
  type OrderRecord,
  type OrderStatus,
} from './orders.ts'
import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import { SERVICE } from './topics.ts'
import type { Clock } from './rng.ts'

/** Every order type the exchange accepts, including the two that wait for a trigger. */
export type PlacedOrderType = OrderType | 'stop_limit' | 'stop_market'

export const PLACED_ORDER_TYPES: readonly PlacedOrderType[] = Object.freeze([
  'limit',
  'market',
  'stop_limit',
  'stop_market',
])

export const isPlacedOrderType = (v: unknown): v is PlacedOrderType =>
  typeof v === 'string' && PLACED_ORDER_TYPES.includes(v as PlacedOrderType)

const isStopType = (type: PlacedOrderType): boolean => type === 'stop_limit' || type === 'stop_market'

/**
 * An order the exchange will not accept, with a machine-readable reason.
 *
 * The `code` is what the browser matches on to put the explanation next to the control that is
 * wrong, so it is part of the interface and is asserted in `src/exchange.test.ts`. The message is
 * for a human and may be reworded freely.
 */
export class OrderRejectedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OrderRejectedError'
    this.code = code
  }
}

/**
 * What a caller is told when the order book is switched off underneath it.
 *
 * One sentence, used by the 503 on every `/v1/exchange` route AND by `GET /v1/capabilities`, so a
 * browser that asks in advance and a browser that finds out the hard way are told the same thing.
 * `TRADE_EXCHANGE_ENABLED` is a legal control rather than a feature toggle — see `src/env.ts` and
 * R-54 in docs/ecosystem/16-risks-and-open-decisions.md — so the wording says "this deployment"
 * rather than "temporarily": it is not an outage and a retry will not fix it.
 */
export const EXCHANGE_DISABLED =
  'the order book is switched off on this deployment — no orders are being accepted'

/** An operation that is valid but not against an order in this state. Answers 409. */
export class OrderStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderStateError'
  }
}

export interface PlaceOrderInput {
  readonly userId: string
  readonly marketId: string
  readonly side: Side
  readonly type: PlacedOrderType
  readonly price: bigint | null
  readonly stopPrice: bigint | null
  readonly qty: bigint | null
  readonly quoteQty: bigint | null
  readonly tif: TimeInForce
  readonly postOnly: boolean
  readonly stp: StpMode
  readonly displayQty: bigint | null
  readonly clientOrderId: string | null
  readonly expiresAtMs: number | null
}

export interface TradeRecord {
  readonly id: string
  readonly seq: bigint
  readonly marketId: string
  readonly takerOrderId: string
  readonly makerOrderId: string
  readonly takerUserId: string
  readonly makerUserId: string
  readonly takerSide: Side
  readonly price: bigint
  readonly qty: bigint
  readonly quoteQty: bigint
  readonly takerFee: bigint
  readonly makerFee: bigint
  readonly takerFeeAsset: 'base' | 'quote'
  readonly makerFeeAsset: 'base' | 'quote'
  readonly createdAt: string
}

interface TradeRow {
  readonly id: string
  readonly seq: string | number
  readonly market_id: string
  readonly taker_order_id: string
  readonly maker_order_id: string
  readonly taker_user_id: string
  readonly maker_user_id: string
  readonly taker_side: string
  readonly price: string
  readonly qty: string
  readonly quote_qty: string
  readonly taker_fee: string
  readonly maker_fee: string
  readonly taker_fee_asset: string
  readonly maker_fee_asset: string
  readonly created_at: Date
}

export const TRADE_COLUMNS = `id, seq, market_id, taker_order_id, maker_order_id, taker_user_id,
  maker_user_id, taker_side, price, qty, quote_qty, taker_fee, maker_fee, taker_fee_asset,
  maker_fee_asset, created_at`

export const toTrade = (row: TradeRow): TradeRecord => ({
  id: row.id,
  seq: BigInt(row.seq),
  marketId: row.market_id,
  takerOrderId: row.taker_order_id,
  makerOrderId: row.maker_order_id,
  takerUserId: row.taker_user_id,
  makerUserId: row.maker_user_id,
  takerSide: row.taker_side as Side,
  price: amountFrom(row.price),
  qty: amountFrom(row.qty),
  quoteQty: amountFrom(row.quote_qty),
  takerFee: amountFrom(row.taker_fee),
  makerFee: amountFrom(row.maker_fee),
  takerFeeAsset: row.taker_fee_asset as 'base' | 'quote',
  makerFeeAsset: row.maker_fee_asset as 'base' | 'quote',
  createdAt: row.created_at.toISOString(),
})

export interface PlaceOrderResult {
  readonly order: OrderRecord
  readonly trades: readonly TradeRecord[]
}

export interface ExchangeDeps {
  readonly sql: Db
  readonly clock: Clock
}

/* ------------------------------------------------------------------ validation */

/**
 * Everything that can be decided about an order without reading the book.
 *
 * Pure, and exported, because these are the rules a customer most often trips over and they deserve
 * a test each rather than a single "it was rejected". The browser reproduces none of them: it
 * DESCRIBES them in tooltips and lets the service decide, so there is exactly one copy.
 */
export function validatePlacement(market: Market, input: PlaceOrderInput): void {
  if (market.status === 'halted') {
    throw new OrderRejectedError('market_halted', `${market.symbol} is halted; no orders are being accepted`)
  }
  if (market.status === 'cancel_only') {
    throw new OrderRejectedError(
      'market_cancel_only',
      `${market.symbol} is accepting cancellations only; existing orders can still be pulled`,
    )
  }
  if (market.status === 'post_only' && (!input.postOnly || input.type !== 'limit')) {
    throw new OrderRejectedError(
      'market_post_only',
      `${market.symbol} is in post-only mode; only limit orders that rest are being accepted`,
    )
  }

  const quoteDriven = input.quoteQty !== null
  if ((input.qty === null) === (input.quoteQty === null)) {
    throw new OrderRejectedError('size_ambiguous', 'give a quantity or a spend, and exactly one of them')
  }
  if (quoteDriven && !(input.side === 'buy' && (input.type === 'market' || input.type === 'stop_market'))) {
    throw new OrderRejectedError(
      'quote_size_not_allowed',
      'a spend amount sizes a market BUY only; every other order is sized in the base asset',
    )
  }

  if (input.qty !== null) {
    if (input.qty <= 0n) throw new OrderRejectedError('qty_not_positive', 'quantity must be greater than zero')
    if (input.qty % market.lotSize !== 0n) {
      throw new OrderRejectedError(
        'qty_not_a_lot',
        `quantity must be a multiple of the lot size, ${market.lotSize.toString()}`,
      )
    }
  }
  if (input.quoteQty !== null && input.quoteQty <= 0n) {
    throw new OrderRejectedError('spend_not_positive', 'the amount to spend must be greater than zero')
  }

  const needsPrice = input.type === 'limit' || input.type === 'stop_limit'
  if (needsPrice && input.price === null) {
    throw new OrderRejectedError('price_required', 'a limit order needs a price')
  }
  if (!needsPrice && input.price !== null) {
    throw new OrderRejectedError('price_not_allowed', 'a market order takes the price the book offers, so it has none')
  }
  if (input.price !== null) {
    if (input.price <= 0n) throw new OrderRejectedError('price_not_positive', 'price must be greater than zero')
    if (input.price % market.tickSize !== 0n) {
      throw new OrderRejectedError(
        'price_not_a_tick',
        `price must be a multiple of the tick size, ${market.tickSize.toString()}`,
      )
    }
    const band = priceBand(market)
    if (band && (input.price < band.low || input.price > band.high)) {
      throw new OrderRejectedError(
        'price_outside_band',
        `price must be within ${market.bandBps / 100}% of the last traded price`,
      )
    }
  }

  if (isStopType(input.type) === (input.stopPrice === null)) {
    throw new OrderRejectedError(
      'stop_price_mismatch',
      'a stop order needs a trigger price, and an order that is not a stop must not have one',
    )
  }
  if (input.stopPrice !== null) {
    if (input.stopPrice <= 0n) {
      throw new OrderRejectedError('stop_price_not_positive', 'the trigger price must be greater than zero')
    }
    if (input.stopPrice % market.tickSize !== 0n) {
      throw new OrderRejectedError(
        'stop_price_not_a_tick',
        `the trigger price must be a multiple of the tick size, ${market.tickSize.toString()}`,
      )
    }
  }

  if (input.postOnly && input.type !== 'limit') {
    throw new OrderRejectedError('post_only_needs_limit', 'post-only applies to a limit order; a market order always takes')
  }
  if (input.postOnly && (input.tif === 'ioc' || input.tif === 'fok')) {
    throw new OrderRejectedError(
      'post_only_conflicts_with_tif',
      'post-only means the order rests, so it cannot also be immediate-or-cancel or fill-or-kill',
    )
  }
  if (input.tif === 'gtd' && input.expiresAtMs === null) {
    throw new OrderRejectedError('expiry_required', 'a good-till-date order needs an expiry')
  }
  if (input.tif !== 'gtd' && input.expiresAtMs !== null) {
    throw new OrderRejectedError('expiry_not_allowed', 'only a good-till-date order carries an expiry')
  }
  if (input.type !== 'limit' && input.tif === 'gtd') {
    throw new OrderRejectedError('gtd_needs_limit', 'a market order never rests, so it cannot be good-till-date')
  }

  if (input.displayQty !== null) {
    if (input.type !== 'limit') {
      throw new OrderRejectedError('display_needs_limit', 'only a resting limit order has a published size')
    }
    if (input.qty === null || input.displayQty <= 0n || input.displayQty > input.qty) {
      throw new OrderRejectedError('display_out_of_range', 'the published size must be between one lot and the full quantity')
    }
    if (input.displayQty % market.lotSize !== 0n) {
      throw new OrderRejectedError('display_not_a_lot', 'the published size must be a multiple of the lot size')
    }
  }

  if (input.clientOrderId !== null && (input.clientOrderId.length === 0 || input.clientOrderId.length > 64)) {
    throw new OrderRejectedError('client_order_id_length', 'your own order reference must be 1 to 64 characters')
  }

  const notional = notionalOfInput(market, input)
  if (notional !== null && notional < market.minNotional) {
    throw new OrderRejectedError(
      'below_min_notional',
      `an order must be worth at least ${market.minNotional.toString()} ${market.quoteAsset}`,
    )
  }
}

/** What the order is worth in quote, where that is knowable before matching. */
function notionalOfInput(market: Market, input: PlaceOrderInput): bigint | null {
  if (input.quoteQty !== null) return input.quoteQty
  if (input.price !== null && input.qty !== null) return notionalOf(rulesOf(market), input.qty, input.price)
  // A market order sized in base has no price until it matches. The minimum is enforced by the
  // engine's own lot rule instead, which is the closest honest equivalent.
  return null
}

export interface Escrow {
  readonly asset: string
  readonly amount: bigint
}

/**
 * What an order must reserve before it may exist.
 *
 * The worst case and exactly the worst case. A buy reserves at ITS OWN limit price, which is the
 * most it can ever pay; every fill at a better price releases the difference.
 */
export function escrowFor(market: Market, input: PlaceOrderInput): Escrow {
  if (input.side === 'sell') {
    if (input.qty === null) throw new OrderRejectedError('size_ambiguous', 'a sell is sized in the base asset')
    return { asset: market.baseAsset, amount: input.qty }
  }
  if (input.quoteQty !== null) return { asset: market.quoteAsset, amount: input.quoteQty }
  if (input.price === null || input.qty === null) {
    throw new OrderRejectedError(
      'market_buy_needs_spend',
      'a market buy is sized by how much you are willing to spend, because until the book is walked there is no honest amount to reserve',
    )
  }
  return { asset: market.quoteAsset, amount: notionalOf(rulesOf(market), input.qty, input.price) }
}

/* ------------------------------------------------------------------ placement */

/** How many rounds of stop-order cascades one placement will run before leaving the rest to the job. */
export const MAX_TRIGGER_ROUNDS = 8

/**
 * Place an order.
 *
 * Returns the order in whatever state it reached — filled, resting, waiting for a trigger,
 * cancelled or rejected — together with every trade it printed. A rejection that the exchange
 * RECORDED (post-only that would have crossed, fill-or-kill that could not fill) comes back as an
 * order with status `rejected` rather than as a thrown error, because the customer asked a question
 * and "here is your order, and here is why it did not live" is the answer. A rejection the exchange
 * refused to record at all — a malformed order, a halted market — throws `OrderRejectedError`,
 * because there is nothing to show them.
 */
export async function placeOrder(deps: ExchangeDeps, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  return withOutbox(deps.sql, SERVICE, async (tx, emit) => placeOrderIn(tx, emit, deps, input))
}

/**
 * The body of a placement, on a caller's transaction.
 *
 * Separated so the idempotency claim and the placement can share ONE transaction — `withIdempotency`
 * owns the transaction in that path, and a placement that committed outside it would be a placement
 * a replayed request could repeat.
 */
export async function placeOrderIn(
  tx: Tx,
  emit: Emit,
  deps: ExchangeDeps,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const market = await lockMarket(tx, input.marketId)
  if (!market) throw new OrderRejectedError('market_unknown', 'no such market')
  // Re-validated under the lock. The pre-flight check outside the transaction is a courtesy; this
  // is the one that decides, because between the two the market can be halted and the band can move.
  validatePlacement(market, input)
  const escrow = escrowFor(market, input)

  await hold(tx, input.userId, escrow.asset, escrow.amount)

  const waiting = isStopType(input.type) && !triggerHasFired(market.lastPrice, input.side, input.stopPrice)
  const inserted = await insertOrder(tx, input, escrow, waiting)
  await recordOrderEvent(tx, inserted.id, 'accepted', {
    qty: input.qty ?? 0n,
    price: input.price ?? null,
    detail: waiting ? 'waiting for its trigger price' : null,
  })

  if (waiting) return { order: inserted, trades: [] }

  const first = await matchAndSettle(tx, market, inserted, emit)
  const trades = [...first.trades]
  let lastPrice = first.lastPrice ?? market.lastPrice

  // The cascade: a fill moves the price, a moved price fires stops, a fired stop fills. Bounded
  // rather than run to a fixed point, because a market whose stops keep firing each other is a
  // market in trouble and a request is the wrong place to discover how long that takes. Whatever is
  // left is picked up by the maintenance job, which is leased and can take as long as it needs.
  for (let round = 0; round < MAX_TRIGGER_ROUNDS && lastPrice !== null; round += 1) {
    const fired = await triggeredOrders(tx, market.id, lastPrice)
    if (fired.length === 0) break
    let moved = false
    for (const order of fired) {
      const promoted = await promote(tx, order)
      const outcome = await matchAndSettle(tx, market, promoted, emit)
      trades.push(...outcome.trades)
      if (outcome.lastPrice !== null) {
        lastPrice = outcome.lastPrice
        moved = true
      }
    }
    if (!moved) break
  }

  const settled = await getOrder(tx, inserted.id)
  return { order: settled ?? inserted, trades }
}

/** Has a stop's trigger condition been met at `lastPrice`? A market with no price has fired nothing. */
export function triggerHasFired(lastPrice: bigint | null, side: Side, stopPrice: bigint | null): boolean {
  if (stopPrice === null) return true
  if (lastPrice === null) return false
  // A buy stop is a breakout above; a sell stop is a stop-loss below. Both are "the market has moved
  // to where I said I wanted in or out".
  return side === 'buy' ? lastPrice >= stopPrice : lastPrice <= stopPrice
}

async function insertOrder(
  tx: Tx,
  input: PlaceOrderInput,
  escrow: Escrow,
  waiting: boolean,
): Promise<OrderRecord> {
  const rows = await tx`
    insert into orders (
      market_id, user_id, client_order_id, side, type, price, stop_price, tif, post_only, stp,
      qty, quote_qty, display_qty, remaining, held_asset, held_amount, status, expires_at
    ) values (
      ${input.marketId}, ${input.userId}, ${input.clientOrderId}, ${input.side}, ${input.type},
      ${input.price === null ? null : input.price.toString()}::numeric,
      ${input.stopPrice === null ? null : input.stopPrice.toString()}::numeric,
      ${input.tif}, ${input.postOnly}, ${input.stp},
      ${input.qty === null ? null : input.qty.toString()}::numeric,
      ${input.quoteQty === null ? null : input.quoteQty.toString()}::numeric,
      ${input.displayQty === null ? null : input.displayQty.toString()}::numeric,
      ${(input.qty ?? 0n).toString()}::numeric,
      ${escrow.asset}, ${escrow.amount.toString()}::numeric,
      ${waiting ? 'pending_trigger' : 'open'},
      ${input.expiresAtMs === null ? null : new Date(input.expiresAtMs)}
    )
    returning ${tx.unsafe(ORDER_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('order insert returned nothing')
  return toOrder(row as never)
}

async function promote(tx: Tx, order: OrderRecord): Promise<OrderRecord> {
  const rows = await tx`
    update orders set status = 'open', updated_at = now()
     where id = ${order.id} and status = 'pending_trigger'
    returning ${tx.unsafe(ORDER_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new OrderStateError('the order stopped waiting for its trigger before it could be promoted')
  await recordOrderEvent(tx, order.id, 'triggered', { price: order.stopPrice })
  return toOrder(row as never)
}

async function triggeredOrders(tx: Tx, marketId: string, lastPrice: bigint): Promise<readonly OrderRecord[]> {
  const rows = await tx`
    select ${tx.unsafe(ORDER_COLUMNS)} from orders
     where market_id = ${marketId} and status = 'pending_trigger'
       and (
         (side = 'buy'  and stop_price <= ${lastPrice.toString()}::numeric) or
         (side = 'sell' and stop_price >= ${lastPrice.toString()}::numeric)
       )
     order by sequence asc
     for update
  `
  return (rows as never as Parameters<typeof toOrder>[0][]).map(toOrder)
}

/* ------------------------------------------------------------------ settlement */

interface MatchOutcome {
  readonly trades: readonly TradeRecord[]
  readonly lastPrice: bigint | null
}

/**
 * Run one order through the engine and write down everything the engine said.
 *
 * The order of operations inside is not arbitrary. Self-trade casualties are applied FIRST, because
 * a maker that the plan cancels must not still be holding an escrow when the fills against its
 * neighbours are written; and the taker's leftover escrow is released LAST, once the exact amount
 * consumed is known.
 */
async function matchAndSettle(
  tx: Tx,
  market: Market,
  order: OrderRecord,
  emit: Emit,
): Promise<MatchOutcome> {
  const rules = rulesOf(market)
  const book = await loadBook(tx, market.id)
  const plan = matchOrder(rules, book.filter((resting) => resting.id !== order.id), takerFrom(market, order))

  if (plan.reject !== null) {
    await release(tx, order.userId, order.heldAsset ?? market.quoteAsset, order.heldAmount)
    await tx`
      update orders
         set status = 'rejected', held_amount = 0, remaining = 0,
             cancel_reason = ${plan.reject}, updated_at = now()
       where id = ${order.id}
    `
    await recordOrderEvent(tx, order.id, 'rejected', { detail: plan.reject })
    return { trades: [], lastPrice: null }
  }

  for (const makerId of plan.cancelledMakerIds) {
    await cancelResting(tx, market, makerId, 'self_trade_prevention')
  }
  for (const decrement of plan.decrementedMakers) {
    await reduceResting(tx, market, decrement.id, decrement.by, 'self_trade_prevention')
  }

  const trades: TradeRecord[] = []
  let lastPrice: bigint | null = null
  for (const fill of plan.fills) {
    await settleFillBalances(tx, market, order, fill)
    await applyToMaker(tx, market, fill)
    trades.push(await printTrade(tx, market, order, fill))
    lastPrice = fill.price
  }

  await applyToTaker(tx, market, order, plan)

  if (lastPrice !== null) {
    await recordLastPrice(tx, market.id, lastPrice)
    emit({
      topic: 'trade.order.filled',
      key: order.id,
      payload: {
        orderId: order.id,
        marketId: market.id,
        symbol: market.symbol,
        userId: order.userId,
        side: order.side,
        filledQty: plan.filledQty.toString(),
        filledQuoteQty: plan.filledQuoteQty.toString(),
        tradeCount: plan.fills.length,
      },
    })
  }

  return { trades, lastPrice }
}

/** The order, in the shape the engine takes. */
function takerFrom(market: Market, order: OrderRecord): TakerOrder {
  const marketish = order.type === 'market' || order.type === 'stop_market'
  return {
    id: order.id,
    userId: order.userId,
    side: order.side,
    type: marketish ? 'market' : 'limit',
    price: order.price,
    qty: order.quoteQty !== null ? null : order.remaining,
    quoteQty: order.quoteQty !== null ? order.quoteQty - order.filledQuoteQty : null,
    tif: order.tif,
    postOnly: order.postOnly,
    stp: order.stp,
    // Only a market order gets a protection price. A limit order already has one, and it is better
    // than the band: the customer named it.
    protectionPrice: marketish ? protectionPriceFor(market, order.side) : null,
  }
}

type Fill = MatchPlan['fills'][number]

/** The four movements one fill makes, and nothing else moves. */
async function settleFillBalances(tx: Tx, market: Market, taker: OrderRecord, fill: Fill): Promise<void> {
  const base = market.baseAsset
  const quote = market.quoteAsset
  if (taker.side === 'buy') {
    await spendHeld(tx, taker.userId, quote, fill.quoteQty)
    await credit(tx, taker.userId, base, fill.qty - fill.takerFee)
    await spendHeld(tx, fill.makerUserId, base, fill.qty)
    await credit(tx, fill.makerUserId, quote, fill.quoteQty - fill.makerFee)
    if (fill.takerFee > 0n) await credit(tx, PLATFORM_ACCOUNT_ID, base, fill.takerFee)
    if (fill.makerFee > 0n) await credit(tx, PLATFORM_ACCOUNT_ID, quote, fill.makerFee)
    return
  }
  await spendHeld(tx, taker.userId, base, fill.qty)
  await credit(tx, taker.userId, quote, fill.quoteQty - fill.takerFee)
  await spendHeld(tx, fill.makerUserId, quote, fill.quoteQty)
  await credit(tx, fill.makerUserId, base, fill.qty - fill.makerFee)
  if (fill.takerFee > 0n) await credit(tx, PLATFORM_ACCOUNT_ID, quote, fill.takerFee)
  if (fill.makerFee > 0n) await credit(tx, PLATFORM_ACCOUNT_ID, base, fill.makerFee)
}

/**
 * Move the maker's own row on.
 *
 * The maker spends exactly what it reserved for this quantity, because the fill happened at the
 * maker's own price — which is the reason the maker's escrow can never be short and never leaves a
 * residue. `held_amount` is decremented by the same number the balance was, so the row and the
 * account cannot disagree.
 */
async function applyToMaker(tx: Tx, market: Market, fill: Fill): Promise<void> {
  const takerBuys = fill.makerFeeAsset === 'quote'
  const spent = takerBuys ? fill.qty : fill.quoteQty
  const feeBase = takerBuys ? 0n : fill.makerFee
  const feeQuote = takerBuys ? fill.makerFee : 0n
  await tx`
    update orders
       set remaining        = remaining - ${fill.qty.toString()}::numeric,
           filled_qty       = filled_qty + ${fill.qty.toString()}::numeric,
           filled_quote_qty = filled_quote_qty + ${fill.quoteQty.toString()}::numeric,
           fee_base         = fee_base + ${feeBase.toString()}::numeric,
           fee_quote        = fee_quote + ${feeQuote.toString()}::numeric,
           held_amount      = held_amount - ${spent.toString()}::numeric,
           status           = case when remaining - ${fill.qty.toString()}::numeric <= 0
                                   then 'filled' else 'open' end,
           updated_at       = now()
     where id = ${fill.makerOrderId} and status = 'open'
  `
  await recordOrderEvent(tx, fill.makerOrderId, 'filled', { qty: fill.qty, price: fill.price })
  void market
}

/**
 * Move the taker's row on and give back whatever was over-reserved.
 *
 * `keptHold` is the only subtle number here: an order that rests keeps exactly enough escrow for
 * what is still open, at its own limit price. Everything else goes back to `available` immediately.
 * A design that kept the whole escrow until the order finished would look identical from the
 * outside and would leave a customer's money locked up behind a price improvement they earned.
 */
async function applyToTaker(tx: Tx, market: Market, order: OrderRecord, plan: MatchPlan): Promise<void> {
  const buying = order.side === 'buy'
  const spent = buying ? plan.filledQuoteQty : plan.filledQty
  const keptHold =
    plan.restable && order.price !== null
      ? buying
        ? notionalOf(rulesOf(market), plan.remainingQty, order.price)
        : plan.remainingQty
      : 0n
  const refund = order.heldAmount - spent - keptHold
  if (refund > 0n) await release(tx, order.userId, order.heldAsset ?? market.quoteAsset, refund)

  const status = terminalStatusFor(order, plan)
  const reason = status === 'cancelled' ? plan.stopReason : null
  await tx`
    update orders
       set remaining        = ${plan.restable ? plan.remainingQty.toString() : '0'}::numeric,
           filled_qty       = filled_qty + ${plan.filledQty.toString()}::numeric,
           filled_quote_qty = filled_quote_qty + ${plan.filledQuoteQty.toString()}::numeric,
           fee_base         = fee_base + ${plan.takerFeeBase.toString()}::numeric,
           fee_quote        = fee_quote + ${plan.takerFeeQuote.toString()}::numeric,
           held_amount      = ${keptHold.toString()}::numeric,
           status           = ${status},
           cancel_reason    = ${reason},
           updated_at       = now()
     where id = ${order.id}
  `
  if (plan.filledQty > 0n) {
    await recordOrderEvent(tx, order.id, 'filled', { qty: plan.filledQty })
  }
  if (status === 'cancelled') {
    await recordOrderEvent(tx, order.id, 'cancelled', { detail: plan.stopReason })
  }
}

/**
 * Where a taker order comes to rest.
 *
 * A quote-driven order counts as filled when its budget cannot buy another lot, because that is what
 * "spend this much" means; reporting it as cancelled would tell a customer something went wrong
 * when the order did exactly what they asked.
 */
export function terminalStatusFor(order: OrderRecord, plan: MatchPlan): OrderStatus {
  if (plan.restable) return 'open'
  if (order.quoteQty !== null) {
    return plan.stopReason === 'filled' || plan.stopReason === 'quote_remainder_below_lot'
      ? 'filled'
      : 'cancelled'
  }
  return plan.remainingQty === 0n ? 'filled' : 'cancelled'
}

async function printTrade(tx: Tx, market: Market, taker: OrderRecord, fill: Fill): Promise<TradeRecord> {
  const rows = await tx<TradeRow[]>`
    insert into trades (
      market_id, taker_order_id, maker_order_id, taker_user_id, maker_user_id, taker_side,
      price, qty, quote_qty, taker_fee, maker_fee, taker_fee_asset, maker_fee_asset
    ) values (
      ${market.id}, ${taker.id}, ${fill.makerOrderId}, ${taker.userId}, ${fill.makerUserId},
      ${taker.side}, ${fill.price.toString()}::numeric, ${fill.qty.toString()}::numeric,
      ${fill.quoteQty.toString()}::numeric, ${fill.takerFee.toString()}::numeric,
      ${fill.makerFee.toString()}::numeric, ${fill.takerFeeAsset}, ${fill.makerFeeAsset}
    )
    returning ${tx.unsafe(TRADE_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('trade insert returned nothing')
  return toTrade(row)
}

/* ------------------------------------------------------------------ cancellation */

/** Take a resting order off the book and give its escrow back. Used by STP, expiry and the customer. */
async function cancelResting(tx: Tx, market: Market, orderId: string, reason: string): Promise<OrderRecord | null> {
  const rows = await tx`
    select ${tx.unsafe(ORDER_COLUMNS)} from orders where id = ${orderId} for update
  `
  const row = rows[0]
  if (!row) return null
  const order = toOrder(row as never)
  if (order.status !== 'open' && order.status !== 'pending_trigger') return order
  if (order.heldAmount > 0n) {
    await release(tx, order.userId, order.heldAsset ?? market.quoteAsset, order.heldAmount)
  }
  const status: OrderStatus = reason === 'expired' ? 'expired' : 'cancelled'
  const updated = await tx`
    update orders
       set status = ${status}, held_amount = 0, cancel_reason = ${reason}, updated_at = now()
     where id = ${orderId}
    returning ${tx.unsafe(ORDER_COLUMNS)}
  `
  await recordOrderEvent(tx, orderId, status === 'expired' ? 'expired' : 'cancelled', {
    qty: order.remaining,
    detail: reason,
  })
  const after = updated[0]
  return after ? toOrder(after as never) : order
}

/**
 * Shrink a resting order without trading against it.
 *
 * Only self-trade prevention's decrement mode produces this. The escrow released is computed at the
 * order's OWN price, which is the price it reserved at, so the row and the account stay in step.
 */
async function reduceResting(tx: Tx, market: Market, orderId: string, by: bigint, reason: string): Promise<void> {
  const rows = await tx`
    select ${tx.unsafe(ORDER_COLUMNS)} from orders where id = ${orderId} for update
  `
  const row = rows[0]
  if (!row) return
  const order = toOrder(row as never)
  if (order.status !== 'open' || by <= 0n) return
  const freed =
    order.side === 'buy' && order.price !== null
      ? notionalOf(rulesOf(market), by, order.price)
      : by
  const capped = freed > order.heldAmount ? order.heldAmount : freed
  if (capped > 0n) await release(tx, order.userId, order.heldAsset ?? market.baseAsset, capped)
  const remaining = order.remaining - by
  await tx`
    update orders
       set remaining     = ${(remaining < 0n ? 0n : remaining).toString()}::numeric,
           held_amount   = held_amount - ${capped.toString()}::numeric,
           status        = ${remaining <= 0n ? 'cancelled' : 'open'},
           cancel_reason = ${remaining <= 0n ? reason : null},
           updated_at    = now()
     where id = ${orderId}
  `
  await recordOrderEvent(tx, orderId, remaining <= 0n ? 'cancelled' : 'reduced', { qty: by, detail: reason })
}

export interface CancelInput {
  readonly userId: string
  readonly orderId: string
}

/**
 * Cancel one order, on its owner's instruction.
 *
 * Throws `OrderStateError` when the order is already done. Not an error the customer caused and not
 * silently successful either: "your order had already filled" is information they need, and
 * answering 200 to a cancel that cancelled nothing is how somebody ends up believing they are flat.
 */
export async function cancelOrder(deps: ExchangeDeps, input: CancelInput): Promise<OrderRecord> {
  return withOutbox(deps.sql, SERVICE, async (tx) => {
    const owned = await tx`
      select ${tx.unsafe(ORDER_COLUMNS)} from orders
       where id = ${input.orderId} and user_id = ${input.userId}
    `
    const row = owned[0]
    if (!row) throw new OrderStateError('no such order')
    const order = toOrder(row as never)
    if (order.status !== 'open' && order.status !== 'pending_trigger') {
      throw new OrderStateError(`this order is already ${order.status} and cannot be cancelled`)
    }
    const market = await lockMarket(tx, order.marketId)
    if (!market) throw new OrderStateError('the market this order belongs to no longer exists')
    const cancelled = await cancelResting(tx, market, order.id, 'cancelled_by_owner')
    return cancelled ?? order
  })
}

export interface CancelAllInput {
  readonly userId: string
  readonly marketId: string | null
}

/**
 * Pull everything, optionally in one market.
 *
 * The panic button, and the reason `order.cancel` carries a looser rate limit than `order.place`
 * (`src/ratelimit.ts`): whatever else the exchange refuses to do, it must let somebody get out.
 */
export async function cancelAllOrders(deps: ExchangeDeps, input: CancelAllInput): Promise<readonly OrderRecord[]> {
  return withOutbox(deps.sql, SERVICE, async (tx) => cancelAllOrdersIn(tx, input))
}

/**
 * The body of a mass cancel, on a caller's transaction.
 *
 * Split out for the same reason `placeOrderIn` is: the route claims an idempotency key in its own
 * transaction, and a cancel that committed outside that claim would be a cancel a replayed request
 * repeats — which matters here more than anywhere, because the honest answer to "what did my panic
 * button cancel" is the list the FIRST attempt produced, not the empty list the retry finds.
 */
export async function cancelAllOrdersIn(tx: Tx, input: CancelAllInput): Promise<readonly OrderRecord[]> {
  const rows = await tx<{ id: string; market_id: string }[]>`
    select id, market_id from orders
     where user_id = ${input.userId}
       and status in ('open','pending_trigger')
       and (${input.marketId}::uuid is null or market_id = ${input.marketId}::uuid)
     order by market_id asc, sequence asc
  `
  const cancelled: OrderRecord[] = []
  // Markets are locked in id order, and the query above returns rows in that order, so two
  // customers cancelling everything at the same time take the locks in the same sequence and
  // cannot deadlock against each other.
  const markets = new Map<string, Market>()
  for (const row of rows) {
    let market = markets.get(row.market_id)
    if (!market) {
      const locked = await lockMarket(tx, row.market_id)
      if (!locked) continue
      market = locked
      markets.set(row.market_id, locked)
    }
    const order = await cancelResting(tx, market, row.id, 'cancelled_by_owner')
    if (order) cancelled.push(order)
  }
  return cancelled
}

/**
 * Expire the good-till-date orders that have reached their time, and fire any stops the market has
 * already moved past.
 *
 * Both are the maintenance job's work rather than a request's, and both are idempotent: an order
 * that is no longer open is skipped by `cancelResting`, and a stop that has already been promoted is
 * no longer `pending_trigger`. The lease key names the MARKET, because the market row's lock is the
 * contended resource and two workers on one market would simply queue behind each other.
 */
export async function maintainMarket(deps: ExchangeDeps, marketId: string): Promise<{ expired: number; triggered: number }> {
  return withOutbox(deps.sql, SERVICE, async (tx, emit) => {
    const market = await lockMarket(tx, marketId)
    if (!market) return { expired: 0, triggered: 0 }

    const due = await tx<{ id: string }[]>`
      select id from orders
       where market_id = ${marketId} and status = 'open'
         and expires_at is not null and expires_at <= ${new Date(deps.clock.now())}
       order by sequence asc
       for update
    `
    for (const row of due) await cancelResting(tx, market, row.id, 'expired')

    let triggered = 0
    let lastPrice = market.lastPrice
    for (let round = 0; round < MAX_TRIGGER_ROUNDS && lastPrice !== null; round += 1) {
      const fired = await triggeredOrders(tx, marketId, lastPrice)
      if (fired.length === 0) break
      let moved = false
      for (const order of fired) {
        const promoted = await promote(tx, order)
        const outcome = await matchAndSettle(tx, market, promoted, emit)
        triggered += 1
        if (outcome.lastPrice !== null) {
          lastPrice = outcome.lastPrice
          moved = true
        }
      }
      if (!moved) break
    }
    return { expired: due.length, triggered }
  })
}

/* ------------------------------------------------------------------ the book, read */

export interface DepthSnapshot {
  readonly bids: readonly { readonly price: bigint; readonly qty: bigint; readonly orders: number }[]
  readonly asks: readonly { readonly price: bigint; readonly qty: bigint; readonly orders: number }[]
}

/**
 * The public book.
 *
 * A reserve order publishes only its `display_qty`, so the size on screen is the size the market has
 * agreed to show — the hidden remainder is still real and still matches, and `src/exchange.test.ts`
 * proves a taker gets more than the depth advertised when it is there. That asymmetry is stated in
 * the browser rather than hidden, because a depth number that silently understates is worse than one
 * that says it may.
 */
export async function marketDepth(sql: Db, marketId: string, limit: number): Promise<DepthSnapshot> {
  const rows = await sql<{ id: string; user_id: string; side: string; price: string; shown: string }[]>`
    select id, user_id, side, price,
           least(remaining, coalesce(display_qty, remaining)) as shown
      from orders
     where market_id = ${marketId} and status = 'open' and remaining > 0
  `
  const visible = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    side: row.side as Side,
    price: amountFrom(row.price),
    remaining: amountFrom(row.shown),
    sequence: 0n,
  }))
  return {
    bids: aggregateDepth(visible, 'buy', limit),
    asks: aggregateDepth(visible, 'sell', limit),
  }
}

/** The best bid and offer, from the same visible book the depth is drawn from. */
export async function bestBidOffer(sql: Db, marketId: string): Promise<{ bid: bigint | null; ask: bigint | null }> {
  const depth = await marketDepth(sql, marketId, 1)
  return { bid: depth.bids[0]?.price ?? null, ask: depth.asks[0]?.price ?? null }
}

/** Exported for the tests that drive ranking against a database-loaded book. */
export { rankBook, baseUnitOf }
