/**
 * The matching engine, proved rather than demonstrated.
 *
 * Every test here runs on literals — no database, no clock, no network — because the properties
 * being asserted are properties of a function. A test that needs a Postgres container to find out
 * whether price-time priority holds is a test that can only ever observe the answer.
 *
 * The four things this file exists to catch:
 *
 *   1. A queue that is not price-then-time. Caught by driving the comparator directly AND by
 *      matching against a shuffled book and asserting the fill ORDER, so a comparator that is right
 *      only because the input happened to be sorted still fails.
 *   2. A fill at the taker's price instead of the maker's. Caught by crossing at a better price and
 *      asserting the price improvement lands with the taker.
 *   3. A self-trade reaching the tape. Caught in all four modes.
 *   4. Money appearing or disappearing. Caught by summing both assets across every fill.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateDepth,
  bookOrder,
  contraSide,
  crosses,
  lotsAffordable,
  matchOrder,
  notionalOf,
  rankBook,
  type MarketRules,
  type RestingOrder,
  type StpMode,
  type TakerOrder,
} from './matching.ts'

const ALICE = 'alice'
const BOB = 'bob'
const CAROL = 'carol'

/**
 * An 8-decimal base against a 2-decimal quote, which is the shape of every coin/USD market this
 * service will list. Lot 10^5 and tick 10^3 satisfy `(lot * tick) % baseUnit === 0` with room to
 * spare, so no fill in this file rounds.
 */
const RULES: MarketRules = Object.freeze({
  baseUnit: 100_000_000n,
  lotSize: 100_000n,
  tickSize: 1_000n,
  minNotional: 100n,
  makerFeeBps: 10,
  takerFeeBps: 20,
})

/** Zero fees, for the tests that are about quantity and not about money. */
const FREE: MarketRules = Object.freeze({ ...RULES, makerFeeBps: 0, takerFeeBps: 0 })

let nextSequence = 0n
function resting(over: Partial<RestingOrder> & Pick<RestingOrder, 'side' | 'price' | 'remaining'>): RestingOrder {
  nextSequence += 1n
  return {
    id: over.id ?? `m${nextSequence}`,
    userId: over.userId ?? BOB,
    sequence: over.sequence ?? nextSequence,
    ...over,
  }
}

function taker(over: Partial<TakerOrder> & Pick<TakerOrder, 'side'>): TakerOrder {
  return {
    id: 't1',
    userId: ALICE,
    type: 'limit',
    price: null,
    qty: null,
    quoteQty: null,
    tif: 'gtc',
    postOnly: false,
    stp: 'cancel_taker',
    protectionPrice: null,
    ...over,
  }
}

describe('price-time priority', () => {
  it('ranks the most aggressive price first on both sides', () => {
    const buys = [
      resting({ side: 'buy', price: 100n, remaining: 1n, sequence: 1n, id: 'a' }),
      resting({ side: 'buy', price: 300n, remaining: 1n, sequence: 2n, id: 'b' }),
      resting({ side: 'buy', price: 200n, remaining: 1n, sequence: 3n, id: 'c' }),
    ]
    assert.deepEqual(rankBook(buys).map((o) => o.id), ['b', 'c', 'a'])

    const sells = [
      resting({ side: 'sell', price: 300n, remaining: 1n, sequence: 1n, id: 'a' }),
      resting({ side: 'sell', price: 100n, remaining: 1n, sequence: 2n, id: 'b' }),
      resting({ side: 'sell', price: 200n, remaining: 1n, sequence: 3n, id: 'c' }),
    ]
    assert.deepEqual(rankBook(sells).map((o) => o.id), ['b', 'c', 'a'])
  })

  it('breaks a price tie on arrival, earliest first, on both sides', () => {
    const late = resting({ side: 'sell', price: 100n, remaining: 1n, sequence: 99n, id: 'late' })
    const early = resting({ side: 'sell', price: 100n, remaining: 1n, sequence: 4n, id: 'early' })
    assert.deepEqual(rankBook([late, early]).map((o) => o.id), ['early', 'late'])
    assert.equal(bookOrder(early, late) < 0, true)
    assert.equal(bookOrder(late, early) > 0, true)
    assert.equal(bookOrder(early, early), 0)
  })

  it('is a total order, so the ranking does not depend on the input order', () => {
    // Every permutation of a book whose ranking is unambiguous must produce the same ranking. A
    // comparator that returned 0 for two different orders would pass a single sorted case and fail
    // here on the permutation that starts them the wrong way round.
    const orders = [
      resting({ side: 'sell', price: 100n, remaining: 1n, sequence: 1n, id: 'a' }),
      resting({ side: 'sell', price: 100n, remaining: 1n, sequence: 2n, id: 'b' }),
      resting({ side: 'sell', price: 200n, remaining: 1n, sequence: 3n, id: 'c' }),
      resting({ side: 'sell', price: 200n, remaining: 1n, sequence: 0n, id: 'd' }),
    ]
    const expected = ['a', 'b', 'd', 'c']
    for (const perm of permutations(orders)) {
      assert.deepEqual(rankBook(perm).map((o) => o.id), expected)
    }
  })

  it('fills a shuffled book in ranked order, not in array order', () => {
    const book = [
      resting({ side: 'sell', price: 200_000n, remaining: 100_000n, sequence: 5n, id: 'third' }),
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n, sequence: 9n, id: 'second' }),
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n, sequence: 2n, id: 'first' }),
    ]
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 200_000n, qty: 300_000n }))
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['first', 'second', 'third'])
    assert.equal(plan.remainingQty, 0n)
    assert.equal(plan.stopReason, 'filled')
  })

  it('is deterministic: the same book and order produce byte-identical plans', () => {
    const book = [
      resting({ side: 'sell', price: 100_000n, remaining: 150_000n, sequence: 3n, id: 'x' }),
      resting({ side: 'sell', price: 100_000n, remaining: 250_000n, sequence: 1n, id: 'y' }),
      resting({ side: 'sell', price: 101_000n, remaining: 900_000n, sequence: 2n, id: 'z' }),
    ]
    const order = taker({ side: 'buy', price: 200_000n, qty: 500_000n })
    const a = matchOrder(RULES, book, order)
    const b = matchOrder(RULES, [...book].reverse(), order)
    assert.deepEqual(stringify(a), stringify(b))
  })
})

describe('the maker sets the price', () => {
  it('gives the price improvement to the taker, never to the platform', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 100_000n, id: 'cheap' })]
    // Alice is willing to pay 150_000 and the resting offer is 100_000.
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 150_000n, qty: 100_000n }))
    assert.equal(plan.fills.length, 1)
    assert.equal(plan.fills[0]?.price, 100_000n)
    assert.equal(plan.filledQuoteQty, notionalOf(FREE, 100_000n, 100_000n))
  })

  it('is symmetric for a seller crossing a better bid', () => {
    const book = [resting({ side: 'buy', price: 200_000n, remaining: 100_000n, userId: BOB })]
    const plan = matchOrder(FREE, book, taker({ side: 'sell', price: 100_000n, qty: 100_000n }))
    assert.equal(plan.fills[0]?.price, 200_000n)
  })

  it('stops at the limit price rather than paying more', () => {
    const book = [
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n, id: 'in' }),
      resting({ side: 'sell', price: 300_000n, remaining: 100_000n, id: 'out' }),
    ]
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 200_000n, qty: 200_000n }))
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['in'])
    assert.equal(plan.stopReason, 'limit_price')
    assert.equal(plan.remainingQty, 100_000n)
    assert.equal(plan.restable, true)
  })
})

describe('fees', () => {
  it('charges each side in the asset it receives, rounded down', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 100_000n, userId: BOB })]
    const plan = matchOrder(RULES, book, taker({ side: 'buy', price: 100_000n, qty: 100_000n }))
    const fill = plan.fills[0]
    assert.ok(fill)
    // Buyer receives base, so the taker fee is base. Seller receives quote, so the maker fee is quote.
    assert.equal(fill.takerFeeAsset, 'base')
    assert.equal(fill.makerFeeAsset, 'quote')
    assert.equal(fill.takerFee, (100_000n * 20n) / 10_000n)
    assert.equal(fill.makerFee, (fill.quoteQty * 10n) / 10_000n)
  })

  it('rounds a sub-unit fee to zero rather than up, so nobody is overcharged', () => {
    // 1 lot at the cheapest tick: the quote notional is small enough that 10 bps of it is a
    // fraction of one smallest unit. The maker keeps it.
    const rules: MarketRules = { ...RULES, makerFeeBps: 1, takerFeeBps: 1 }
    const book = [resting({ side: 'sell', price: 1_000n, remaining: 100_000n, userId: BOB })]
    const plan = matchOrder(rules, book, taker({ side: 'buy', price: 1_000n, qty: 100_000n }))
    const fill = plan.fills[0]
    assert.ok(fill)
    assert.equal(fill.quoteQty, 1n)
    assert.equal(fill.makerFee, 0n)
    assert.equal(fill.takerFee, (100_000n * 1n) / 10_000n)
  })

  it('never charges a fee larger than the amount received', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 500_000n, userId: BOB })]
    const plan = matchOrder(RULES, book, taker({ side: 'buy', price: 100_000n, qty: 500_000n }))
    for (const fill of plan.fills) {
      assert.equal(fill.takerFee <= (fill.takerFeeAsset === 'base' ? fill.qty : fill.quoteQty), true)
      assert.equal(fill.makerFee <= (fill.makerFeeAsset === 'base' ? fill.qty : fill.quoteQty), true)
    }
  })

  it('sums the taker fee per asset so the caller debits it once', () => {
    const book = [
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n }),
      resting({ side: 'sell', price: 110_000n, remaining: 100_000n }),
    ]
    const plan = matchOrder(RULES, book, taker({ side: 'buy', price: 200_000n, qty: 200_000n }))
    const expected = plan.fills.reduce((sum, f) => sum + f.takerFee, 0n)
    assert.equal(plan.takerFeeBase, expected)
    assert.equal(plan.takerFeeQuote, 0n)
  })
})

describe('conservation', () => {
  it('moves exactly as much base and quote as it takes away, fees included', () => {
    const book = [
      resting({ side: 'sell', price: 100_000n, remaining: 300_000n, userId: BOB }),
      resting({ side: 'sell', price: 123_000n, remaining: 400_000n, userId: CAROL }),
      resting({ side: 'sell', price: 150_000n, remaining: 900_000n, userId: BOB }),
    ]
    const plan = matchOrder(RULES, book, taker({ side: 'buy', price: 150_000n, qty: 1_000_000n }))

    // Base: the taker is credited (qty - takerFee), the makers are debited qty in full, the
    // platform takes the difference. Quote: the mirror.
    let baseOut = 0n
    let baseIn = 0n
    let quoteOut = 0n
    let quoteIn = 0n
    for (const fill of plan.fills) {
      baseOut += fill.qty
      baseIn += fill.qty - fill.takerFee
      quoteOut += fill.quoteQty
      quoteIn += fill.quoteQty - fill.makerFee
      assert.equal(fill.takerFeeAsset, 'base')
      assert.equal(fill.makerFeeAsset, 'quote')
    }
    const platformBase = plan.fills.reduce((s, f) => s + f.takerFee, 0n)
    const platformQuote = plan.fills.reduce((s, f) => s + f.makerFee, 0n)
    assert.equal(baseIn + platformBase, baseOut)
    assert.equal(quoteIn + platformQuote, quoteOut)
    assert.equal(plan.filledQty, baseOut)
    assert.equal(plan.filledQuoteQty, quoteOut)
  })

  it('never computes an inexact notional under the market invariant', () => {
    // Every combination of a whole number of lots and a whole number of ticks is exact, which is
    // what the market creation rule buys. If this throws, the rule was not enforced.
    for (let lots = 1n; lots <= 40n; lots += 1n) {
      for (let ticks = 1n; ticks <= 40n; ticks += 1n) {
        const qty = lots * RULES.lotSize
        const price = ticks * RULES.tickSize
        assert.equal(notionalOf(RULES, qty, price), (qty * price) / RULES.baseUnit)
      }
    }
  })

  it('refuses to silently truncate a notional when the market rules are inconsistent', () => {
    const broken: MarketRules = { ...RULES, lotSize: 1n, tickSize: 1n }
    assert.throws(() => notionalOf(broken, 1n, 1n), RangeError)
  })
})

describe('self-trade prevention', () => {
  const own = () => [
    resting({ side: 'sell', price: 100_000n, remaining: 200_000n, userId: ALICE, id: 'mine', sequence: 1n }),
    resting({ side: 'sell', price: 100_000n, remaining: 200_000n, userId: BOB, id: 'theirs', sequence: 2n }),
  ]

  it('never prints a trade between one account and itself, in any mode', () => {
    for (const mode of ['cancel_taker', 'cancel_maker', 'cancel_both', 'decrement_and_cancel'] as StpMode[]) {
      const plan = matchOrder(FREE, own(), taker({ side: 'buy', price: 100_000n, qty: 400_000n, stp: mode }))
      for (const fill of plan.fills) {
        assert.notEqual(fill.makerUserId, ALICE, `${mode} printed a self-trade`)
      }
    }
  })

  it('cancel_taker stops the incoming order and leaves the book alone', () => {
    const plan = matchOrder(FREE, own(), taker({ side: 'buy', price: 100_000n, qty: 400_000n, stp: 'cancel_taker' }))
    assert.deepEqual(plan.fills, [])
    assert.deepEqual(plan.cancelledMakerIds, [])
    assert.equal(plan.stopReason, 'self_trade_prevention')
    assert.equal(plan.restable, false)
  })

  it('cancel_maker removes the resting order and carries on', () => {
    const plan = matchOrder(FREE, own(), taker({ side: 'buy', price: 100_000n, qty: 400_000n, stp: 'cancel_maker' }))
    assert.deepEqual(plan.cancelledMakerIds, ['mine'])
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['theirs'])
    assert.equal(plan.filledQty, 200_000n)
  })

  it('cancel_both removes the resting order and stops the incoming one', () => {
    const plan = matchOrder(FREE, own(), taker({ side: 'buy', price: 100_000n, qty: 400_000n, stp: 'cancel_both' }))
    assert.deepEqual(plan.cancelledMakerIds, ['mine'])
    assert.deepEqual(plan.fills, [])
    assert.equal(plan.stopReason, 'self_trade_prevention')
  })

  it('decrement_and_cancel reduces both by the smaller and cancels whichever empties', () => {
    // Taker wants 100_000; the resting own order has 200_000. The taker empties first.
    const small = matchOrder(FREE, own(), taker({ side: 'buy', price: 100_000n, qty: 100_000n, stp: 'decrement_and_cancel' }))
    assert.deepEqual(small.decrementedMakers, [{ id: 'mine', by: 100_000n }])
    assert.deepEqual(small.cancelledMakerIds, [])
    assert.deepEqual(small.fills, [])
    assert.equal(small.stopReason, 'self_trade_prevention')

    // Taker wants 500_000; the resting own order has 200_000. The maker empties, is cancelled, and
    // the taker carries on into the rest of the book with 300_000 left.
    const big = matchOrder(FREE, own(), taker({ side: 'buy', price: 100_000n, qty: 500_000n, stp: 'decrement_and_cancel' }))
    assert.deepEqual(big.decrementedMakers, [{ id: 'mine', by: 200_000n }])
    assert.deepEqual(big.cancelledMakerIds, ['mine'])
    assert.deepEqual(big.fills.map((f) => f.makerOrderId), ['theirs'])
    assert.equal(big.filledQty, 200_000n)
    assert.equal(big.remainingQty, 100_000n)
  })

  it('degrades decrement to a maker cancel on a quote-driven order, rather than inventing a quantity', () => {
    const plan = matchOrder(
      FREE,
      own(),
      taker({ side: 'buy', type: 'market', price: null, qty: null, quoteQty: 1_000_000n, stp: 'decrement_and_cancel' }),
    )
    assert.deepEqual(plan.cancelledMakerIds, ['mine'])
    assert.deepEqual(plan.decrementedMakers, [])
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['theirs'])
  })

  it('leaves another account’s identical order alone', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 200_000n, userId: BOB, id: 'theirs' })]
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 100_000n, qty: 200_000n, stp: 'cancel_both' }))
    assert.deepEqual(plan.cancelledMakerIds, [])
    assert.equal(plan.filledQty, 200_000n)
  })
})

describe('time in force', () => {
  const book = () => [
    resting({ side: 'sell', price: 100_000n, remaining: 100_000n, id: 'a' }),
    resting({ side: 'sell', price: 110_000n, remaining: 100_000n, id: 'b' }),
  ]

  it('gtc rests the remainder', () => {
    const plan = matchOrder(FREE, book(), taker({ side: 'buy', price: 100_000n, qty: 500_000n, tif: 'gtc' }))
    assert.equal(plan.remainingQty, 400_000n)
    assert.equal(plan.restable, true)
  })

  it('gtd rests the remainder too; the expiry is enforced elsewhere', () => {
    const plan = matchOrder(FREE, book(), taker({ side: 'buy', price: 100_000n, qty: 500_000n, tif: 'gtd' }))
    assert.equal(plan.restable, true)
  })

  it('ioc takes what is there and never rests', () => {
    const plan = matchOrder(FREE, book(), taker({ side: 'buy', price: 100_000n, qty: 500_000n, tif: 'ioc' }))
    assert.equal(plan.filledQty, 100_000n)
    assert.equal(plan.remainingQty, 400_000n)
    assert.equal(plan.restable, false)
    assert.equal(plan.reject, null)
  })

  it('fok that cannot fill in full does nothing at all', () => {
    const plan = matchOrder(FREE, book(), taker({ side: 'buy', price: 200_000n, qty: 500_000n, tif: 'fok' }))
    assert.equal(plan.reject, 'fill_or_kill_unfillable')
    assert.deepEqual(plan.fills, [])
    assert.equal(plan.filledQty, 0n)
    assert.equal(plan.restable, false)
  })

  it('fok that can fill in full fills in full', () => {
    const plan = matchOrder(FREE, book(), taker({ side: 'buy', price: 200_000n, qty: 200_000n, tif: 'fok' }))
    assert.equal(plan.reject, null)
    assert.equal(plan.filledQty, 200_000n)
  })

  it('a killed fok reports no maker casualties, so the caller has nothing to apply', () => {
    const self = [
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n, userId: ALICE, id: 'mine' }),
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n, userId: BOB, id: 'theirs' }),
    ]
    const plan = matchOrder(
      FREE,
      self,
      taker({ side: 'buy', price: 100_000n, qty: 900_000n, tif: 'fok', stp: 'cancel_maker' }),
    )
    assert.equal(plan.reject, 'fill_or_kill_unfillable')
    assert.deepEqual(plan.cancelledMakerIds, [])
    assert.deepEqual(plan.decrementedMakers, [])
  })
})

describe('post-only', () => {
  it('refuses an order that would cross, rather than taking', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 100_000n })]
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 100_000n, qty: 100_000n, postOnly: true }))
    assert.equal(plan.reject, 'post_only_would_cross')
    assert.deepEqual(plan.fills, [])
  })

  it('accepts an order that rests behind the spread', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 100_000n })]
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 99_000n, qty: 100_000n, postOnly: true }))
    assert.equal(plan.reject, null)
    assert.deepEqual(plan.fills, [])
    assert.equal(plan.restable, true)
    assert.equal(plan.remainingQty, 100_000n)
  })

  it('accepts on an empty book', () => {
    const plan = matchOrder(FREE, [], taker({ side: 'buy', price: 99_000n, qty: 100_000n, postOnly: true }))
    assert.equal(plan.reject, null)
    assert.equal(plan.restable, true)
  })

  it('ignores the same side of the book entirely', () => {
    // A resting BUY at a higher price is not something a new buy can cross.
    const book = [resting({ side: 'buy', price: 500_000n, remaining: 100_000n })]
    const plan = matchOrder(FREE, book, taker({ side: 'buy', price: 400_000n, qty: 100_000n, postOnly: true }))
    assert.equal(plan.reject, null)
  })
})

describe('market orders', () => {
  it('a quote-driven buy spends money and returns the remainder', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 200_000n })]
    // 200_000 base at price 100_000 costs 200 quote. Offer 250 and expect 50 back.
    const plan = matchOrder(
      FREE,
      book,
      taker({ side: 'buy', type: 'market', price: null, qty: null, quoteQty: 250n }),
    )
    assert.equal(plan.filledQty, 200_000n)
    assert.equal(plan.filledQuoteQty, 200n)
    assert.equal(plan.remainingQuoteQty, 50n)
    assert.equal(plan.restable, false)
  })

  it('stops when the money left cannot buy a whole lot', () => {
    const book = [resting({ side: 'sell', price: 100_000n, remaining: 10_000_000n })]
    const plan = matchOrder(
      FREE,
      book,
      taker({ side: 'buy', type: 'market', price: null, qty: null, quoteQty: 150n }),
    )
    // One lot is 100_000 base, costing 100 quote at this price. 150 buys one and cannot buy two.
    assert.equal(plan.filledQty, 100_000n)
    assert.equal(plan.remainingQuoteQty, 50n)
  })

  it('a quantity-driven sell walks the bids', () => {
    const book = [
      resting({ side: 'buy', price: 120_000n, remaining: 100_000n, id: 'high' }),
      resting({ side: 'buy', price: 100_000n, remaining: 100_000n, id: 'low' }),
    ]
    const plan = matchOrder(FREE, book, taker({ side: 'sell', type: 'market', price: null, qty: 200_000n }))
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['high', 'low'])
    assert.equal(plan.filledQuoteQty, 220n)
  })

  it('is rejected outright against an empty book rather than accepted and cancelled', () => {
    const plan = matchOrder(FREE, [], taker({ side: 'sell', type: 'market', price: null, qty: 100_000n }))
    assert.equal(plan.reject, 'no_liquidity')
  })

  it('stops at the protection price instead of walking a thin book to the top', () => {
    const book = [
      resting({ side: 'sell', price: 100_000n, remaining: 100_000n, id: 'sane' }),
      resting({ side: 'sell', price: 9_000_000n, remaining: 100_000n, id: 'absurd' }),
    ]
    const plan = matchOrder(
      FREE,
      book,
      taker({ side: 'buy', type: 'market', price: null, qty: 200_000n, protectionPrice: 200_000n }),
    )
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['sane'])
    assert.equal(plan.stopReason, 'protection_price')
    assert.equal(plan.remainingQty, 100_000n)
    assert.equal(plan.restable, false)
  })

  it('a protection price applies to a sell in the opposite direction', () => {
    const book = [
      resting({ side: 'buy', price: 100_000n, remaining: 100_000n, id: 'sane' }),
      resting({ side: 'buy', price: 1n, remaining: 100_000n, id: 'absurd' }),
    ]
    const plan = matchOrder(
      FREE,
      book,
      taker({ side: 'sell', type: 'market', price: null, qty: 200_000n, protectionPrice: 50_000n }),
    )
    assert.deepEqual(plan.fills.map((f) => f.makerOrderId), ['sane'])
    assert.equal(plan.stopReason, 'protection_price')
  })
})

describe('the small helpers, driven directly', () => {
  it('crosses is inclusive at the touch and directional', () => {
    assert.equal(crosses('buy', 100n, 100n), true)
    assert.equal(crosses('buy', 99n, 100n), false)
    assert.equal(crosses('sell', 100n, 100n), true)
    assert.equal(crosses('sell', 101n, 100n), false)
    assert.equal(crosses('buy', null, 10n ** 30n), true)
  })

  it('contraSide is an involution', () => {
    assert.equal(contraSide('buy'), 'sell')
    assert.equal(contraSide(contraSide('buy')), 'buy')
  })

  it('lotsAffordable rounds down to a whole lot and never goes negative', () => {
    assert.equal(lotsAffordable(RULES, 100n, 100_000n), 100_000n)
    assert.equal(lotsAffordable(RULES, 199n, 100_000n), 100_000n)
    assert.equal(lotsAffordable(RULES, 99n, 100_000n), 0n)
    assert.equal(lotsAffordable(RULES, 0n, 100_000n), 0n)
    assert.equal(lotsAffordable(RULES, 100n, 0n), 0n)
  })
})

describe('aggregated depth', () => {
  const book = [
    resting({ side: 'sell', price: 100n, remaining: 5n, id: 'a' }),
    resting({ side: 'sell', price: 100n, remaining: 7n, id: 'b' }),
    resting({ side: 'sell', price: 200n, remaining: 1n, id: 'c' }),
    resting({ side: 'buy', price: 90n, remaining: 3n, id: 'd' }),
    resting({ side: 'buy', price: 80n, remaining: 4n, id: 'e' }),
  ]

  it('sums quantity per price and counts the orders behind it', () => {
    assert.deepEqual(aggregateDepth(book, 'sell', 10), [
      { price: 100n, qty: 12n, orders: 2 },
      { price: 200n, qty: 1n, orders: 1 },
    ])
  })

  it('orders bids high-first and asks low-first, so both read best-first', () => {
    assert.deepEqual(aggregateDepth(book, 'buy', 10).map((l) => l.price), [90n, 80n])
    assert.deepEqual(aggregateDepth(book, 'sell', 10).map((l) => l.price), [100n, 200n])
  })

  it('truncates to the limit from the best side', () => {
    assert.deepEqual(aggregateDepth(book, 'sell', 1).map((l) => l.price), [100n])
    assert.deepEqual(aggregateDepth(book, 'sell', 0), [])
  })

  it('drops exhausted orders rather than publishing a level with no size', () => {
    const spent = [...book, resting({ side: 'sell', price: 50n, remaining: 0n, id: 'spent' })]
    assert.equal(aggregateDepth(spent, 'sell', 10).some((l) => l.price === 50n), false)
  })
})

/** Every permutation of a small array. Used to prove the comparator is a total order. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i] as T
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) out.push([head, ...tail])
  }
  return out
}

/** `JSON.stringify` refuses a bigint, and every amount here is one. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
}
