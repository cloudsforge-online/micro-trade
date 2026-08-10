/**
 * The matching engine. Pure, deterministic, and completely unaware of the database.
 *
 * ## Why this file has no `sql` in it
 *
 * A matching engine that reads rows is a matching engine you can only test by standing up a
 * database and racing it, and the properties that actually matter — that the same book and the same
 * incoming order always produce the same fills, in the same order, at the same prices — are then
 * only ever observed, never proved. So the rule here is that `matchOrder` is a FUNCTION: book in,
 * decision out. `src/exchange.ts` is the part that holds the lock, reads the book, calls this, and
 * writes what it says. Everything in this file can be driven with literals.
 *
 * That split is also what makes the decision reversible. `matchOrder` returns a plan and never a
 * side effect, so a caller that does not like the plan — a fill-or-kill that could not be filled,
 * a post-only that would have crossed — throws the whole thing away and nothing has happened. If
 * the cancellations were applied as the walk discovered them, "reject the order" would already
 * have cost somebody their resting quote.
 *
 * ## Price-time priority, stated once
 *
 * Two resting orders are ranked by price first and by ARRIVAL second, and arrival is a single
 * `bigint` sequence number drawn from one sequence for the whole market. It is not a timestamp:
 * two orders accepted in the same millisecond are a routine event and `now()` cannot order them,
 * whereas `nextval` can and does. `src/exchange.ts` draws that number INSIDE the market's row lock,
 * so the order in which orders take the lock is the order in which they are numbered, which is the
 * order in which they match. See `bookOrder`.
 *
 * ## Whose price is used
 *
 * The MAKER's. A taker who is willing to pay 101 and finds a resting offer at 100 pays 100, and the
 * difference is theirs, not the platform's. This is the universal convention and it is also the only
 * one that makes a limit price mean what a reader thinks it means: "no worse than".
 *
 * ## Which asset a fee is taken in
 *
 * The one the party RECEIVES. A buyer receives base and pays the fee in base; a seller receives
 * quote and pays the fee in quote. That way a fee is always deductible from something that just
 * arrived, so no fill can ever leave an account short — which is what happens if you charge a
 * buyer's fee in quote against an escrow that was sized for the trade and not for the trade plus a
 * fee. Every fee is `applyBps`, which rounds DOWN, per the rule stated in `src/money.ts`: the house
 * eats the remainder. Rounding a fee down can never overcharge.
 *
 * ## Conservation
 *
 * Every fill moves exactly `qty` base and `quoteQty` quote between the two parties, and the fees are
 * carved out of those same two numbers. Nothing is created. `src/exchange.test.ts` asserts the whole
 * invariant against the database after a randomised session; `src/matching.test.ts` asserts it on
 * the plan itself, where it is a property of arithmetic rather than of SQL.
 */

import { applyBps } from './money.ts'

export type Side = 'buy' | 'sell'
export type OrderType = 'limit' | 'market'

/**
 * How long an order lives.
 *
 *   `gtc` — rests until filled or cancelled.
 *   `ioc` — takes what is available now; the remainder is cancelled, never rested.
 *   `fok` — fills in full immediately or does nothing at all.
 *   `gtd` — like `gtc` with an expiry the maintenance job enforces.
 */
export type TimeInForce = 'gtc' | 'ioc' | 'fok' | 'gtd'

/**
 * What to do when an order would trade against its own account.
 *
 * Self-trading is not merely embarrassing; it is how wash trades are printed, and a public tape
 * that carries them is a lie about volume. The TAKER's mode governs the interaction — the incoming
 * order is the one that chose to cross, so it is the one whose policy applies.
 *
 *   `cancel_taker`          — the incoming order stops dead. The book is untouched.
 *   `cancel_maker`          — the resting order is cancelled and the taker carries on past it.
 *   `cancel_both`           — the resting order is cancelled and the taker stops.
 *   `decrement_and_cancel`  — both sides are reduced by the smaller of the two remaining
 *                             quantities, and whichever reaches zero is cancelled. No trade is
 *                             printed. This is the mode that preserves the most intent: a large
 *                             resting quote survives a small crossing order.
 */
export type StpMode = 'cancel_taker' | 'cancel_maker' | 'cancel_both' | 'decrement_and_cancel'

export const SIDES: readonly Side[] = Object.freeze(['buy', 'sell'])
export const ORDER_TYPES: readonly OrderType[] = Object.freeze(['limit', 'market'])
export const TIME_IN_FORCE: readonly TimeInForce[] = Object.freeze(['gtc', 'ioc', 'fok', 'gtd'])
export const STP_MODES: readonly StpMode[] = Object.freeze([
  'cancel_taker',
  'cancel_maker',
  'cancel_both',
  'decrement_and_cancel',
])

export const isSide = (v: unknown): v is Side => typeof v === 'string' && SIDES.includes(v as Side)
export const isOrderType = (v: unknown): v is OrderType =>
  typeof v === 'string' && ORDER_TYPES.includes(v as OrderType)
export const isTimeInForce = (v: unknown): v is TimeInForce =>
  typeof v === 'string' && TIME_IN_FORCE.includes(v as TimeInForce)
export const isStpMode = (v: unknown): v is StpMode =>
  typeof v === 'string' && STP_MODES.includes(v as StpMode)

/** The other side of the book — the side an order of `side` matches against. */
export const contraSide = (side: Side): Side => (side === 'buy' ? 'sell' : 'buy')

/**
 * The market's arithmetic, all of it integer.
 *
 * `baseUnit` is `10 ** base_decimals`: the number of smallest base units in one WHOLE base unit.
 * Price is quoted in quote smallest-units per one whole base unit, so a fill's notional is
 * `qty * price / baseUnit` — and that division is the one place a market could round money away.
 * It cannot, because `src/markets.ts` refuses to create a market unless
 * `(lotSize * tickSize) % baseUnit === 0`, and every quantity is a multiple of `lotSize` and every
 * price a multiple of `tickSize`. `notionalOf` asserts it anyway; a silent truncation here would be
 * money vanishing.
 */
export interface MarketRules {
  readonly baseUnit: bigint
  readonly lotSize: bigint
  readonly tickSize: bigint
  readonly minNotional: bigint
  readonly makerFeeBps: number
  readonly takerFeeBps: number
}

/** One resting order, as far as matching is concerned. */
export interface RestingOrder {
  readonly id: string
  readonly userId: string
  readonly side: Side
  readonly price: bigint
  /** Base units still open. Always a positive multiple of `lotSize`. */
  readonly remaining: bigint
  /** Arrival rank. Unique across the market, monotonically increasing. */
  readonly sequence: bigint
}

/** The incoming order, before anything has happened to it. */
export interface TakerOrder {
  readonly id: string
  readonly userId: string
  readonly side: Side
  readonly type: OrderType
  /** `null` for a market order, which has no price of its own. */
  readonly price: bigint | null
  /** Base units requested. `null` only on a quote-driven market buy. */
  readonly qty: bigint | null
  /** Quote units to spend. Market buys only; see `matchOrder`. */
  readonly quoteQty: bigint | null
  readonly tif: TimeInForce
  readonly postOnly: boolean
  readonly stp: StpMode
  /**
   * The worst price this order will accept, or `null` for none. A market order has no limit of its
   * own, so `src/exchange.ts` derives one from the market's price band and passes it here. Without
   * it a market order in a thin book walks to the last resting quote at any price, which is the
   * single most common way a retail user loses a balance to a fat finger.
   */
  readonly protectionPrice: bigint | null
}

export type FeeAsset = 'base' | 'quote'

/** One printed trade. */
export interface PlannedFill {
  readonly makerOrderId: string
  readonly makerUserId: string
  readonly makerSequence: bigint
  /** The maker's price. The taker's, if better, is not used; see the header. */
  readonly price: bigint
  readonly qty: bigint
  readonly quoteQty: bigint
  readonly takerFee: bigint
  readonly makerFee: bigint
  readonly takerFeeAsset: FeeAsset
  readonly makerFeeAsset: FeeAsset
  /** True when the maker order is fully consumed by this fill. */
  readonly makerClosed: boolean
}

/** Why an order stopped short of what it asked for. */
export type StopReason =
  | 'filled'
  | 'book_exhausted'
  | 'limit_price'
  | 'protection_price'
  | 'self_trade_prevention'
  | 'quote_remainder_below_lot'

/** Why nothing at all happened. A rejected order never touches the book. */
export type RejectReason = 'post_only_would_cross' | 'fill_or_kill_unfillable' | 'no_liquidity'

/**
 * What the engine decided. Advisory until the caller applies it.
 *
 * `cancelledMakerIds` and `decrementedMakers` are the self-trade-prevention casualties: makers the
 * caller must cancel or reduce even though no trade printed against them. They are reported
 * separately from `fills` precisely because they are not trades and must never reach the tape.
 */
export interface MatchPlan {
  readonly fills: readonly PlannedFill[]
  readonly filledQty: bigint
  readonly filledQuoteQty: bigint
  /** Taker fee totals, summed per asset, for the caller to debit in one movement. */
  readonly takerFeeBase: bigint
  readonly takerFeeQuote: bigint
  /** Base units left over. Rested only when `restable` is true. */
  readonly remainingQty: bigint
  /**
   * Quote units left over on a quote-driven market buy. Always returned to the taker: a market
   * order never rests, so there is nothing for the remainder to fund.
   */
  readonly remainingQuoteQty: bigint
  readonly stopReason: StopReason
  /** True when `remainingQty` should become a resting order. False for market, IOC and FOK. */
  readonly restable: boolean
  readonly cancelledMakerIds: readonly string[]
  readonly decrementedMakers: readonly { readonly id: string; readonly by: bigint }[]
  /** Set when the whole order is refused. `fills` is then empty and nothing may be applied. */
  readonly reject: RejectReason | null
}

/**
 * The comparator that IS price-time priority.
 *
 * Sorting a side of the book with this and taking from the front is the entire ranking rule, which
 * is why it is exported and tested on its own: a bug here is not a wrong fill, it is a wrong
 * QUEUE, and a wrong queue is invisible until somebody counts.
 *
 * Buys rank high price first, sells low price first — in both cases "most aggressive first" — and
 * ties break on the lower sequence, which is the earlier arrival. `sequence` is unique across the
 * market, so this is a total order and the sort is deterministic without depending on whether the
 * runtime's sort is stable.
 */
export function bookOrder(a: RestingOrder, b: RestingOrder): number {
  if (a.price !== b.price) {
    if (a.side === 'buy') return a.price > b.price ? -1 : 1
    return a.price < b.price ? -1 : 1
  }
  if (a.sequence === b.sequence) return 0
  return a.sequence < b.sequence ? -1 : 1
}

/** The book side, ranked. A copy: the caller's array is never reordered under it. */
export function rankBook(orders: readonly RestingOrder[]): readonly RestingOrder[] {
  return [...orders].sort(bookOrder)
}

/** Would an order at `price` (or a market order, `null`) trade against a resting order at `restingPrice`? */
export function crosses(side: Side, price: bigint | null, restingPrice: bigint): boolean {
  if (price === null) return true
  return side === 'buy' ? price >= restingPrice : price <= restingPrice
}

/** `qty * price / baseUnit`, and it is an error for that to be inexact. See `MarketRules`. */
export function notionalOf(rules: MarketRules, qty: bigint, price: bigint): bigint {
  const raw = qty * price
  if (raw % rules.baseUnit !== 0n) {
    throw new RangeError('notional is not exact; market lot and tick sizes are inconsistent')
  }
  return raw / rules.baseUnit
}

/** The largest whole number of LOTS of base that `quote` buys at `price`. Rounds down. */
export function lotsAffordable(rules: MarketRules, quote: bigint, price: bigint): bigint {
  if (price <= 0n || quote <= 0n) return 0n
  const rawQty = (quote * rules.baseUnit) / price
  return (rawQty / rules.lotSize) * rules.lotSize
}

const feeAssetFor = (side: Side): FeeAsset => (side === 'buy' ? 'base' : 'quote')

interface Working {
  readonly id: string
  readonly userId: string
  readonly sequence: bigint
  readonly price: bigint
  remaining: bigint
}

/**
 * Match one incoming order against one side of a book.
 *
 * ## The quantity the walk is bounded by
 *
 * A limit order and a market SELL are bounded by `qty`, base units. A market BUY may instead be
 * bounded by `quoteQty` — and that is not a convenience, it is the only honest way to accept one.
 * A market buy has no price, so "buy 3 units" cannot say how much money it will cost until the book
 * has been walked, and an exchange that accepts it has to either escrow the customer's entire
 * balance or let the fill overdraw them. Bounding by money instead makes the worst case exactly the
 * number the customer typed. `src/exchange.ts` refuses a market buy that supplies neither and
 * refuses a market sell that supplies `quoteQty`, so the rule is enforced at the edge and this
 * function may assume it.
 *
 * ## Order of operations
 *
 * Post-only is checked before anything else, because a post-only order that would cross is not a
 * trade decision at all — it is a mistake the customer asked to be protected from. Fill-or-kill is
 * checked AFTER the walk, against the walk's own result, so that it kills for exactly the reasons
 * the walk found and cannot disagree with it. That is why the plan is advisory: a killed FOK
 * returns the walk it would have made and a `reject`, and the caller drops all of it.
 */
export function matchOrder(
  rules: MarketRules,
  book: readonly RestingOrder[],
  taker: TakerOrder,
): MatchPlan {
  const wantQty = taker.qty ?? 0n
  const wantQuote = taker.quoteQty ?? 0n
  const quoteDriven = taker.qty === null

  const contra = rankBook(book.filter((o) => o.side === contraSide(taker.side)))
  const best = contra[0]

  // Post-only means "maker or nothing". Checked against the best contra price only: if the top of
  // the book does not cross, nothing behind it can.
  if (taker.postOnly && best && crosses(taker.side, taker.price, best.price)) {
    return reject('post_only_would_cross', wantQty, wantQuote)
  }

  const working: Working[] = contra.map((o) => ({
    id: o.id,
    userId: o.userId,
    sequence: o.sequence,
    price: o.price,
    remaining: o.remaining,
  }))

  const fills: PlannedFill[] = []
  const cancelledMakerIds: string[] = []
  const decrementedMakers: { id: string; by: bigint }[] = []
  let remainingQty = wantQty
  let remainingQuote = wantQuote
  let filledQty = 0n
  let filledQuoteQty = 0n
  let takerFeeBase = 0n
  let takerFeeQuote = 0n
  let stopReason: StopReason = 'book_exhausted'
  let takerStopped = false

  for (const maker of working) {
    if (takerStopped) break
    if (quoteDriven ? remainingQuote <= 0n : remainingQty <= 0n) {
      stopReason = 'filled'
      break
    }
    if (!crosses(taker.side, taker.price, maker.price)) {
      stopReason = 'limit_price'
      break
    }
    // The protection price is the market order's substitute for a limit. Applied to the MAKER's
    // price, because that is the price the taker would actually pay.
    if (taker.protectionPrice !== null && !crosses(taker.side, taker.protectionPrice, maker.price)) {
      stopReason = 'protection_price'
      break
    }

    if (maker.userId === taker.userId) {
      const outcome = preventSelfTrade(taker.stp, maker, quoteDriven ? null : remainingQty)
      if (outcome.cancelMaker) cancelledMakerIds.push(maker.id)
      if (outcome.decrementBy > 0n) {
        decrementedMakers.push({ id: maker.id, by: outcome.decrementBy })
        maker.remaining -= outcome.decrementBy
        if (!quoteDriven) remainingQty -= outcome.decrementBy
      }
      if (outcome.cancelTaker) {
        stopReason = 'self_trade_prevention'
        takerStopped = true
      }
      continue
    }

    const affordable = quoteDriven
      ? lotsAffordable(rules, remainingQuote, maker.price)
      : remainingQty
    const qty = affordable < maker.remaining ? affordable : maker.remaining
    if (qty <= 0n) {
      // Quote-driven only: what is left cannot buy a whole lot. Stopping is correct — the leftover
      // is returned rather than spent on a partial lot that the market's own rules forbid.
      stopReason = 'quote_remainder_below_lot'
      break
    }

    const quoteQty = notionalOf(rules, qty, maker.price)
    // The self-trade branch above always `continue`s, so maker and taker are different accounts
    // here and the maker is unconditionally on the contra side.
    const takerFeeAsset = feeAssetFor(taker.side)
    const makerFeeAsset = feeAssetFor(contraSide(taker.side))
    const takerFee = applyBps(takerFeeAsset === 'base' ? qty : quoteQty, rules.takerFeeBps)
    const makerFee = applyBps(makerFeeAsset === 'base' ? qty : quoteQty, rules.makerFeeBps)

    maker.remaining -= qty
    fills.push({
      makerOrderId: maker.id,
      makerUserId: maker.userId,
      makerSequence: maker.sequence,
      price: maker.price,
      qty,
      quoteQty,
      takerFee,
      makerFee,
      takerFeeAsset,
      makerFeeAsset,
      makerClosed: maker.remaining === 0n,
    })

    filledQty += qty
    filledQuoteQty += quoteQty
    if (takerFeeAsset === 'base') takerFeeBase += takerFee
    else takerFeeQuote += takerFee
    if (quoteDriven) remainingQuote -= quoteQty
    else remainingQty -= qty
  }

  if (!takerStopped && stopReason === 'book_exhausted') {
    if (quoteDriven ? remainingQuote <= 0n : remainingQty <= 0n) stopReason = 'filled'
  }

  // Fill-or-kill, judged on the walk rather than on a separate prediction of it. A quote-driven FOK
  // is satisfied when the money is spent, not when a quantity is reached, because a quantity was
  // never named.
  if (taker.tif === 'fok') {
    const complete = quoteDriven ? remainingQuote === 0n : remainingQty === 0n
    if (!complete) return reject('fill_or_kill_unfillable', wantQty, wantQuote)
  }

  // A market order that touched nothing has no book to wait in and no price to rest at. Saying so
  // is better than accepting it and reporting a fully cancelled order a moment later.
  if (taker.type === 'market' && filledQty === 0n) {
    return reject('no_liquidity', wantQty, wantQuote)
  }

  // `takerStopped` is the self-trade-prevention cancellation. An order that was cancelled must not
  // then be rested — that would put the very order the customer's policy just killed onto the book,
  // where it would sit waiting to trade against the account it was protecting.
  const restable =
    taker.type === 'limit' &&
    taker.tif !== 'ioc' &&
    taker.tif !== 'fok' &&
    !takerStopped &&
    remainingQty > 0n

  return {
    fills,
    filledQty,
    filledQuoteQty,
    takerFeeBase,
    takerFeeQuote,
    remainingQty,
    remainingQuoteQty: quoteDriven ? remainingQuote : 0n,
    stopReason,
    restable,
    cancelledMakerIds,
    decrementedMakers,
    reject: null,
  }
}

interface StpOutcome {
  readonly cancelMaker: boolean
  readonly cancelTaker: boolean
  readonly decrementBy: bigint
}

/**
 * The four modes, in one place, so the walk above reads as a walk.
 *
 * `takerRemaining` is `null` on a quote-driven order: there is no base quantity to decrement
 * against, so `decrement_and_cancel` degrades to cancelling the maker. That degradation is
 * deliberate and stated rather than silent — the alternative is inventing a base quantity from the
 * maker's price, which would make the outcome depend on the price of an order that must not trade.
 */
function preventSelfTrade(mode: StpMode, maker: Working, takerRemaining: bigint | null): StpOutcome {
  switch (mode) {
    case 'cancel_taker':
      return { cancelMaker: false, cancelTaker: true, decrementBy: 0n }
    case 'cancel_maker':
      return { cancelMaker: true, cancelTaker: false, decrementBy: 0n }
    case 'cancel_both':
      return { cancelMaker: true, cancelTaker: true, decrementBy: 0n }
    case 'decrement_and_cancel': {
      if (takerRemaining === null) return { cancelMaker: true, cancelTaker: false, decrementBy: 0n }
      const by = takerRemaining < maker.remaining ? takerRemaining : maker.remaining
      const makerEmptied = by >= maker.remaining
      const takerEmptied = by >= takerRemaining
      return { cancelMaker: makerEmptied, cancelTaker: takerEmptied, decrementBy: by }
    }
  }
}

function reject(reason: RejectReason, qty: bigint, quoteQty: bigint): MatchPlan {
  return {
    fills: [],
    filledQty: 0n,
    filledQuoteQty: 0n,
    takerFeeBase: 0n,
    takerFeeQuote: 0n,
    remainingQty: qty,
    remainingQuoteQty: quoteQty,
    stopReason: 'book_exhausted',
    restable: false,
    cancelledMakerIds: [],
    decrementedMakers: [],
    reject: reason,
  }
}

/** One level of aggregated depth. */
export interface DepthLevel {
  readonly price: bigint
  readonly qty: bigint
  readonly orders: number
}

/**
 * Aggregate one side into price levels, best first.
 *
 * Depth is published aggregated rather than order-by-order on purpose: an order-level feed lets a
 * reader watch an individual participant's quote move, which is information the participant did not
 * agree to publish. Aggregation is also what makes the number on screen the one that matters, which
 * is how much is available at a price, not how many people are offering it.
 */
export function aggregateDepth(
  orders: readonly RestingOrder[],
  side: Side,
  limit: number,
): readonly DepthLevel[] {
  const levels = new Map<string, { price: bigint; qty: bigint; orders: number }>()
  for (const order of orders) {
    if (order.side !== side) continue
    if (order.remaining <= 0n) continue
    const key = order.price.toString()
    const level = levels.get(key)
    if (level) {
      level.qty += order.remaining
      level.orders += 1
    } else {
      levels.set(key, { price: order.price, qty: order.remaining, orders: 1 })
    }
  }
  const sorted = [...levels.values()].sort((a, b) =>
    a.price === b.price ? 0 : side === 'buy' ? (a.price > b.price ? -1 : 1) : a.price < b.price ? -1 : 1,
  )
  return sorted.slice(0, Math.max(0, limit)).map((l) => Object.freeze({ ...l }))
}
