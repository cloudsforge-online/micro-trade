/**
 * The exchange against a real database.
 *
 * `src/matching.test.ts` proves the ENGINE on literals. This file proves the half the engine cannot
 * see: that what the engine decided is what the database ends up holding. The two are separated
 * because they fail for different reasons and a single suite covering both would make every failure
 * ambiguous between "the plan was wrong" and "the plan was applied wrongly".
 *
 * The five properties this file exists to hold down:
 *
 *   1. **Conservation.** Matching moves money between rows and must never change the total. Asserted
 *      as one SUM over `exchange_accounts` before and after — including the platform's fee income,
 *      which is why fees are an ordinary row under `PLATFORM_ACCOUNT_ID` rather than a second table.
 *      A randomised session at the bottom of this file does it over hundreds of movements.
 *   2. **Escrow exactness.** An order holds its own worst case and not a unit more, and a fill at a
 *      better price gives the difference back in the same transaction.
 *   3. **A rejected order leaves nothing behind.** Post-only that would cross, fill-or-kill that
 *      cannot fill, self-trade prevention: in every case the escrow comes back in full.
 *   4. **The published book is not the real book.** A reserve order shows `display_qty` and matches
 *      its whole size, and a test proves a taker gets more than the depth advertised.
 *   5. **Triggers and expiry actually fire**, both inside a placement's cascade and from the
 *      maintenance job.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach, describe } from 'node:test'
import type postgres from 'postgres'
import {
  OrderRejectedError,
  OrderStateError,
  cancelAllOrders,
  cancelOrder,
  escrowFor,
  maintainMarket,
  marketDepth,
  placeOrder,
  validatePlacement,
  type PlaceOrderInput,
} from './exchange.ts'
import { PLATFORM_ACCOUNT_ID, InsufficientFundsError, getBalance } from './accounts.ts'
import { getMarket, setMarketStatus, type Market } from './markets.ts'
import { getOrder, listOrderEvents } from './orders.ts'
import { recentTrades, ticker } from './marketdata.ts'
import { seededRandom } from './rng.ts'
import {
  ALICE,
  BOB,
  assetInCustody,
  enabled,
  migrateTestDb,
  openDb,
  resetTrade,
  seedBalance,
  seedMarket,
  skip,
  testClock,
  type TestClock,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

/** A third account, so a self-trade test has somebody uninvolved to prove nothing leaked onto. */
const CAROL = '33333333-3333-4333-8333-333333333333'

let sql: postgres.Sql
let db: Db
let clock: TestClock
let marketId: string
let market: Market

/**
 * The numbers every test below is written in.
 *
 * One lot is `LOT` base units and one tick is `TICK` quote units. `(LOT * TICK) % 10^8 === 0`, which
 * is the `markets_notional_exact` CHECK — break it and every fill throws `RangeError` instead of
 * testing anything, so the constants are named here once rather than typed out per test.
 */
const LOT = 100_000n
const TICK = 1_000_000_000_000n
const BASE_UNIT = 100_000_000n

/** Ten lots. Small enough to read, large enough that a fee of 20 bps is not zero. */
const TEN_LOTS = LOT * 10n
const PRICE = TICK * 2n

/** `qty * price / 10^base_decimals`, spelled out so a test asserting on it is asserting on arithmetic. */
const notional = (qty: bigint, price: bigint): bigint => (qty * price) / BASE_UNIT

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetTrade(sql)
  clock = testClock()
  marketId = await seedMarket(db)
  market = (await getMarket(db, marketId)) as Market
})

after(async () => {
  if (enabled) await sql.end({ timeout: 5 })
})

const deps = (): { sql: Db; clock: TestClock } => ({ sql: db, clock })

/** A placement with every field present, so a test states only what it is about. */
function order(over: Partial<PlaceOrderInput> & Pick<PlaceOrderInput, 'userId' | 'side'>): PlaceOrderInput {
  return {
    marketId,
    type: 'limit',
    price: PRICE,
    stopPrice: null,
    qty: TEN_LOTS,
    quoteQty: null,
    tif: 'gtc',
    postOnly: false,
    stp: 'cancel_taker',
    displayQty: null,
    clientOrderId: null,
    expiresAtMs: null,
    ...over,
  }
}

/** Both totals, for the conservation assertions. */
async function custody(): Promise<{ base: bigint; quote: bigint }> {
  return {
    base: await assetInCustody(db, market.baseAsset),
    quote: await assetInCustody(db, market.quoteAsset),
  }
}

/* ------------------------------------------------------------------ escrow */

describe('escrow', { skip }, () => {
  test('a resting buy holds exactly its notional, and not a unit more for a fee', async () => {
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))

    assert.equal(placed.order.status, 'open')
    const held = notional(TEN_LOTS, PRICE)
    const balance = await getBalance(db, ALICE, market.quoteAsset)
    assert.equal(balance.held, held)
    assert.equal(balance.available, 1_000_000_000_000n - held)
    // The row and the account agree, which is the invariant every release below depends on.
    assert.equal(placed.order.heldAmount, held)
    assert.equal(placed.order.heldAsset, market.quoteAsset)
  })

  test('a resting sell holds its quantity in the base asset, because that is what it delivers', async () => {
    await seedBalance(db, ALICE, market.baseAsset, TEN_LOTS * 5n)
    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'sell' }))

    const balance = await getBalance(db, ALICE, market.baseAsset)
    assert.equal(balance.held, TEN_LOTS)
    assert.equal(balance.available, TEN_LOTS * 4n)
    assert.equal(placed.order.heldAsset, market.baseAsset)
  })

  test('an order nobody can pay for never exists', async () => {
    await seedBalance(db, ALICE, market.quoteAsset, 1n)
    await assert.rejects(
      () => placeOrder(deps(), order({ userId: ALICE, side: 'buy' })),
      InsufficientFundsError,
    )
    // Not "rejected", not "cancelled": there is no row at all. The escrow is taken before the insert
    // precisely so that a customer who cannot pay leaves no trace on the book.
    const rows = await sql`select count(*)::int as n from orders`
    assert.equal((rows[0] as { n: number }).n, 0)
  })

  test('what a placement will reserve is stated by escrowFor and is the same number', () => {
    const buy = escrowFor(market, order({ userId: ALICE, side: 'buy' }))
    assert.deepEqual(buy, { asset: market.quoteAsset, amount: notional(TEN_LOTS, PRICE) })
    const sell = escrowFor(market, order({ userId: ALICE, side: 'sell' }))
    assert.deepEqual(sell, { asset: market.baseAsset, amount: TEN_LOTS })
  })
})

/* ------------------------------------------------------------------ a crossing pair */

describe('a fill', { skip }, () => {
  beforeEach(async () => {
    if (!enabled) return
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    await seedBalance(db, BOB, market.baseAsset, TEN_LOTS * 10n)
  })

  test('moves both balances, prints a trade, and creates nothing', async () => {
    const startingCustody = await custody()
    await placeOrder(deps(), order({ userId: BOB, side: 'sell' }))
    const taken = await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))

    assert.equal(taken.trades.length, 1)
    assert.equal(taken.order.status, 'filled')
    const cost = notional(TEN_LOTS, PRICE)

    const aliceBase = await getBalance(db, ALICE, market.baseAsset)
    const aliceQuote = await getBalance(db, ALICE, market.quoteAsset)
    const bobBase = await getBalance(db, BOB, market.baseAsset)
    const bobQuote = await getBalance(db, BOB, market.quoteAsset)
    assert.equal(aliceBase.available, TEN_LOTS)
    assert.equal(aliceQuote.available, 1_000_000_000_000n - cost)
    assert.equal(aliceQuote.held, 0n)
    assert.equal(bobBase.available, TEN_LOTS * 9n)
    assert.equal(bobBase.held, 0n)
    assert.equal(bobQuote.available, cost)

    assert.deepEqual(await custody(), startingCustody)
  })

  test('happens at the maker price, and the taker gets the difference back immediately', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', price: PRICE }))
    // Alice is willing to pay half as much again. She reserves at her own price, which is the most
    // she can ever pay, and the fill happens at Bob's.
    const generous = PRICE + TICK
    const taken = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', price: generous }))

    assert.equal(taken.trades[0]?.price, PRICE)
    const paid = notional(TEN_LOTS, PRICE)
    const reserved = notional(TEN_LOTS, generous)
    assert.ok(reserved > paid)

    const quote = await getBalance(db, ALICE, market.quoteAsset)
    // The improvement is in `available` and not in `held`: a customer who earned a better price does
    // not have to wait for the order to close before they can spend the difference.
    assert.equal(quote.held, 0n)
    assert.equal(quote.available, 1_000_000_000_000n - paid)
  })

  test('leaves a partially filled resting order holding only what is still open', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', qty: LOT * 4n }))
    const taken = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', qty: TEN_LOTS }))

    assert.equal(taken.order.status, 'open')
    assert.equal(taken.order.remaining, LOT * 6n)
    assert.equal(taken.order.heldAmount, notional(LOT * 6n, PRICE))
    const quote = await getBalance(db, ALICE, market.quoteAsset)
    assert.equal(quote.held, notional(LOT * 6n, PRICE))
  })

  test('is on the tape and in the day, derived from the trades and not from a counter', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell' }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))

    const tape = await recentTrades(db, marketId, 10)
    assert.equal(tape.length, 1)
    assert.equal(tape[0]?.takerSide, 'buy')
    assert.equal(tape[0]?.price, PRICE)

    const day = await ticker(db, marketId, clock.now())
    assert.equal(day.last, PRICE)
    assert.equal(day.baseVolume, TEN_LOTS)
    assert.equal(day.quoteVolume, notional(TEN_LOTS, PRICE))
    assert.equal(day.trades, 1)
  })
})

/* ------------------------------------------------------------------ fees */

describe('fees', { skip }, () => {
  test('are taken in the asset each side receives, and land in the platform account', async () => {
    const feeMarketId = await seedMarket(db, { makerFeeBps: 10, takerFeeBps: 20 })
    const feeMarket = (await getMarket(db, feeMarketId)) as Market
    await seedBalance(db, ALICE, feeMarket.quoteAsset, 1_000_000_000_000n)
    await seedBalance(db, BOB, feeMarket.baseAsset, TEN_LOTS)

    const baseBefore = await assetInCustody(db, feeMarket.baseAsset)
    const quoteBefore = await assetInCustody(db, feeMarket.quoteAsset)

    await placeOrder(deps(), order({ userId: BOB, side: 'sell', marketId: feeMarketId }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy', marketId: feeMarketId }))

    const cost = notional(TEN_LOTS, PRICE)
    // The buyer receives base, so the taker fee is in base. The seller receives quote, so the maker
    // fee is in quote. Neither fee had to be escrowed, which is the whole reason for the choice.
    const takerFee = (TEN_LOTS * 20n) / 10_000n
    const makerFee = (cost * 10n) / 10_000n

    assert.equal((await getBalance(db, ALICE, feeMarket.baseAsset)).available, TEN_LOTS - takerFee)
    assert.equal((await getBalance(db, BOB, feeMarket.quoteAsset)).available, cost - makerFee)
    assert.equal((await getBalance(db, PLATFORM_ACCOUNT_ID, feeMarket.baseAsset)).available, takerFee)
    assert.equal((await getBalance(db, PLATFORM_ACCOUNT_ID, feeMarket.quoteAsset)).available, makerFee)

    // Fee income is inside the same sum, so charging a fee is a movement and never an issuance.
    assert.equal(await assetInCustody(db, feeMarket.baseAsset), baseBefore)
    assert.equal(await assetInCustody(db, feeMarket.quoteAsset), quoteBefore)
  })
})

/* ------------------------------------------------------------------ refusals */

describe('an order the exchange refuses', { skip }, () => {
  beforeEach(async () => {
    if (!enabled) return
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    await seedBalance(db, ALICE, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, BOB, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, BOB, market.quoteAsset, 1_000_000_000_000n)
  })

  test('records a post-only that would have crossed, and gives the money back in full', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', price: PRICE }))
    const beforeBalance = await getBalance(db, ALICE, market.quoteAsset)

    const placed = await placeOrder(
      deps(),
      order({ userId: ALICE, side: 'buy', price: PRICE, postOnly: true }),
    )

    // Recorded rather than thrown: the customer asked a question and the answer is a row they can
    // look at. `rejected` and `cancelled` are kept apart so they can tell "never started" from
    // "stopped early".
    assert.equal(placed.order.status, 'rejected')
    assert.equal(placed.order.cancelReason, 'post_only_would_cross')
    assert.equal(placed.order.heldAmount, 0n)
    const after = await getBalance(db, ALICE, market.quoteAsset)
    assert.equal(after.available, beforeBalance.available)
    assert.equal(after.held, 0n)
  })

  test('records a fill-or-kill that could not fill, and gives the money back in full', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', qty: LOT }))
    const beforeBalance = await getBalance(db, ALICE, market.quoteAsset)

    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', tif: 'fok' }))

    assert.equal(placed.order.status, 'rejected')
    assert.equal(placed.order.cancelReason, 'fill_or_kill_unfillable')
    assert.equal(placed.trades.length, 0)
    assert.equal((await getBalance(db, ALICE, market.quoteAsset)).available, beforeBalance.available)
    // And the maker it did not trade with is untouched.
    const bobBase = await getBalance(db, BOB, market.baseAsset)
    assert.equal(bobBase.held, LOT)
  })

  test('cancels the remainder of an immediate-or-cancel order rather than resting it', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', qty: LOT * 4n }))
    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', tif: 'ioc' }))

    assert.equal(placed.order.status, 'cancelled')
    assert.equal(placed.order.filledQty, LOT * 4n)
    assert.equal(placed.order.heldAmount, 0n)
    const quote = await getBalance(db, ALICE, market.quoteAsset)
    assert.equal(quote.held, 0n)
    assert.equal(quote.available, 1_000_000_000_000n - notional(LOT * 4n, PRICE))
  })

  test('will not accept anything at all in a halted market', async () => {
    await setMarketStatus(db, marketId, 'halted')
    await assert.rejects(
      () => placeOrder(deps(), order({ userId: ALICE, side: 'buy' })),
      (err: unknown) => err instanceof OrderRejectedError && err.code === 'market_halted',
    )
  })

  test('accepts only resting limit orders in post-only mode, so a book can be rebuilt', async () => {
    await setMarketStatus(db, marketId, 'post_only')
    await assert.rejects(
      () => placeOrder(deps(), order({ userId: ALICE, side: 'buy', type: 'market', price: null, quoteQty: 1n, qty: null })),
      (err: unknown) => err instanceof OrderRejectedError && err.code === 'market_post_only',
    )
    const rested = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', postOnly: true }))
    assert.equal(rested.order.status, 'open')
  })

  test('states the rule it broke with a code a browser can point at a control', () => {
    const cases: readonly [Partial<PlaceOrderInput>, string][] = [
      [{ qty: LOT + 1n }, 'qty_not_a_lot'],
      [{ price: PRICE + 1n }, 'price_not_a_tick'],
      [{ qty: null, quoteQty: null }, 'size_ambiguous'],
      [{ postOnly: true, tif: 'ioc' }, 'post_only_conflicts_with_tif'],
      [{ tif: 'gtd' }, 'expiry_required'],
      [{ displayQty: TEN_LOTS * 2n }, 'display_out_of_range'],
      [{ type: 'stop_limit', stopPrice: null }, 'stop_price_mismatch'],
      [{ stopPrice: PRICE }, 'stop_price_mismatch'],
    ]
    for (const [over, code] of cases) {
      assert.throws(
        () => validatePlacement(market, order({ userId: ALICE, side: 'buy', ...over })),
        (err: unknown) => err instanceof OrderRejectedError && err.code === code,
        `expected ${code}`,
      )
    }
  })

  test('refuses a market buy sized in the base asset, because it cannot say what to reserve', () => {
    // Not caught by `validatePlacement`, and deliberately so: the rule is not about the shape of the
    // request, it is about there being no honest worst case to hold. `escrowFor` is where that is
    // known, so that is where it is refused.
    const bad = order({ userId: ALICE, side: 'buy', type: 'market', price: null, qty: TEN_LOTS })
    validatePlacement(market, bad)
    assert.throws(
      () => escrowFor(market, bad),
      (err: unknown) => err instanceof OrderRejectedError && err.code === 'market_buy_needs_spend',
    )
  })

  test('refuses a price outside the band once the market has traded', async () => {
    // A market with no reference price has no band: the first trades have nothing to be measured
    // against, and inventing a reference would be worse than admitting there is none.
    const narrowId = await seedMarket(db, { bandBps: 100 })
    await seedBalance(db, ALICE, 'EMBER', 1_000_000_000_000n)
    await seedBalance(db, BOB, 'BTC', TEN_LOTS * 4n)
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', marketId: narrowId }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy', marketId: narrowId }))

    await assert.rejects(
      () => placeOrder(deps(), order({ userId: ALICE, side: 'buy', marketId: narrowId, price: PRICE * 2n })),
      (err: unknown) => err instanceof OrderRejectedError && err.code === 'price_outside_band',
    )
  })
})

/* ------------------------------------------------------------------ self-trade prevention */

describe('self-trade prevention', { skip }, () => {
  beforeEach(async () => {
    if (!enabled) return
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    await seedBalance(db, ALICE, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, CAROL, market.baseAsset, TEN_LOTS * 10n)
  })

  test('cancel_taker stops the incoming order and leaves the resting one alone', async () => {
    const resting = await placeOrder(deps(), order({ userId: ALICE, side: 'sell' }))
    const beforeBalance = await getBalance(db, ALICE, market.quoteAsset)

    const taker = await placeOrder(
      deps(),
      order({ userId: ALICE, side: 'buy', stp: 'cancel_taker' }),
    )

    assert.equal(taker.order.status, 'cancelled')
    assert.equal(taker.order.cancelReason, 'self_trade_prevention')
    assert.equal(taker.trades.length, 0)
    // The order that was cancelled must not then be rested: that would put it on the book waiting to
    // trade against the very account the policy was protecting.
    assert.equal(taker.order.remaining, 0n)
    assert.equal((await getOrder(db, resting.order.id))?.status, 'open')
    assert.equal((await getBalance(db, ALICE, market.quoteAsset)).available, beforeBalance.available)
  })

  test('cancel_maker pulls the resting order and refunds it, then lets the taker through', async () => {
    const resting = await placeOrder(deps(), order({ userId: ALICE, side: 'sell' }))
    await placeOrder(deps(), order({ userId: CAROL, side: 'sell', price: PRICE }))

    const taker = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', stp: 'cancel_maker' }))

    const pulled = await getOrder(db, resting.order.id)
    assert.equal(pulled?.status, 'cancelled')
    assert.equal(pulled?.cancelReason, 'self_trade_prevention')
    assert.equal(pulled?.heldAmount, 0n)
    // Alice's own base escrow came back, and the fill she did get was against Carol.
    assert.equal(taker.trades.length, 1)
    assert.equal(taker.trades[0]?.makerUserId, CAROL)
  })

  test('never puts a self-trade on the tape, in any mode', async () => {
    for (const mode of ['cancel_taker', 'cancel_maker', 'cancel_both', 'decrement_and_cancel'] as const) {
      await resetTrade(sql)
      marketId = await seedMarket(db)
      market = (await getMarket(db, marketId)) as Market
      await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
      await seedBalance(db, ALICE, market.baseAsset, TEN_LOTS * 10n)

      await placeOrder(deps(), order({ userId: ALICE, side: 'sell' }))
      await placeOrder(deps(), order({ userId: ALICE, side: 'buy', stp: mode }))

      const tape = await recentTrades(db, marketId, 10)
      assert.equal(tape.length, 0, `${mode} printed a self-trade`)
    }
  })
})

/* ------------------------------------------------------------------ the published book */

describe('the published book', { skip }, () => {
  test('shows a reserve order at its display size and matches it at its real one', async () => {
    await seedBalance(db, BOB, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', qty: TEN_LOTS, displayQty: LOT }))

    const depth = await marketDepth(db, marketId, 10)
    assert.equal(depth.asks.length, 1)
    // One lot is advertised where ten are available. Understating is the point of a reserve order;
    // the browser says so rather than pretending the number is the whole truth.
    assert.equal(depth.asks[0]?.qty, LOT)

    const taken = await placeOrder(deps(), order({ userId: ALICE, side: 'buy', qty: TEN_LOTS }))
    assert.equal(taken.order.status, 'filled')
    assert.equal(taken.order.filledQty, TEN_LOTS)
  })

  test('aggregates a price level across orders and counts them', async () => {
    await seedBalance(db, BOB, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, CAROL, market.baseAsset, TEN_LOTS * 10n)
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', qty: LOT * 2n }))
    await placeOrder(deps(), order({ userId: CAROL, side: 'sell', qty: LOT * 3n }))

    const depth = await marketDepth(db, marketId, 10)
    assert.equal(depth.asks[0]?.qty, LOT * 5n)
    assert.equal(depth.asks[0]?.orders, 2)
  })

  test('does not publish an order that is waiting for its trigger', async () => {
    await seedBalance(db, BOB, market.baseAsset, TEN_LOTS * 10n)
    await placeOrder(
      deps(),
      order({ userId: BOB, side: 'sell', type: 'stop_limit', stopPrice: TICK, price: PRICE }),
    )
    const depth = await marketDepth(db, marketId, 10)
    assert.equal(depth.asks.length, 0)
  })
})

/* ------------------------------------------------------------------ triggers and expiry */

describe('a stop order', { skip }, () => {
  beforeEach(async () => {
    if (!enabled) return
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    await seedBalance(db, ALICE, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, BOB, market.baseAsset, TEN_LOTS * 10n)
    await seedBalance(db, CAROL, market.quoteAsset, 1_000_000_000_000n)
  })

  test('waits off the book with its money already reserved', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell' }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))

    const stop = await placeOrder(
      deps(),
      order({ userId: ALICE, side: 'buy', type: 'stop_limit', stopPrice: PRICE * 2n, price: PRICE * 2n }),
    )
    assert.equal(stop.order.status, 'pending_trigger')
    // A stop that cannot pay when it fires is not a stop, which is why the escrow is taken now.
    assert.equal(stop.order.heldAmount, notional(TEN_LOTS, PRICE * 2n))
    const events = await listOrderEvents(db, stop.order.id)
    assert.equal(events[0]?.kind, 'accepted')
    assert.equal(events[0]?.detail, 'waiting for its trigger price')
  })

  test('fires inside the placement whose price moved past it', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell' }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))

    const stop = await placeOrder(
      deps(),
      order({ userId: ALICE, side: 'buy', type: 'stop_limit', stopPrice: PRICE * 2n, price: PRICE * 2n }),
    )
    // Bob sells into Carol at twice the price, which drags the last price up through Alice's trigger.
    await placeOrder(deps(), order({ userId: BOB, side: 'sell', price: PRICE * 2n }))
    await placeOrder(deps(), order({ userId: CAROL, side: 'buy', price: PRICE * 2n }))

    const fired = await getOrder(db, stop.order.id)
    assert.notEqual(fired?.status, 'pending_trigger')
    const kinds = (await listOrderEvents(db, stop.order.id)).map((event) => event.kind)
    assert.ok(kinds.includes('triggered'), `expected a trigger event, saw ${kinds.join(', ')}`)
  })

  test('never waits when its trigger has already been passed, and leaves the job nothing to do', async () => {
    await placeOrder(deps(), order({ userId: BOB, side: 'sell' }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))
    // Placed against a price that has ALREADY moved past its trigger. Accepting it as
    // `pending_trigger` and waiting for the next tick would be a stop that never fires in a market
    // that never trades again, so the condition is evaluated at placement, not only on the way past.
    const stop = await placeOrder(
      deps(),
      order({ userId: ALICE, side: 'buy', type: 'stop_limit', stopPrice: PRICE, price: PRICE }),
    )
    assert.equal(stop.order.status, 'open')

    // And the job, which is the backstop for the cascade running out of rounds, correctly finds
    // nothing outstanding. Asserted so "the job triggered it" can never pass by triggering
    // everything it looks at.
    assert.deepEqual(await maintainMarket(deps(), marketId), { expired: 0, triggered: 0 })
  })
})

describe('a good-till-date order', { skip }, () => {
  test('is expired by the maintenance job, and its escrow comes back', async () => {
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    const placed = await placeOrder(
      deps(),
      order({ userId: ALICE, side: 'buy', tif: 'gtd', expiresAtMs: clock.now() + 60_000 }),
    )
    assert.equal(placed.order.status, 'open')

    // Before its time, nothing happens. Asserted so that "the job expired it" cannot pass by
    // expiring everything it looks at.
    assert.deepEqual(await maintainMarket(deps(), marketId), { expired: 0, triggered: 0 })
    assert.equal((await getBalance(db, ALICE, market.quoteAsset)).held, notional(TEN_LOTS, PRICE))

    clock.advance(120_000)
    assert.deepEqual(await maintainMarket(deps(), marketId), { expired: 1, triggered: 0 })

    const expired = await getOrder(db, placed.order.id)
    assert.equal(expired?.status, 'expired')
    assert.equal(expired?.heldAmount, 0n)
    const balance = await getBalance(db, ALICE, market.quoteAsset)
    assert.equal(balance.held, 0n)
    assert.equal(balance.available, 1_000_000_000_000n)
  })
})

/* ------------------------------------------------------------------ cancellation */

describe('cancellation', { skip }, () => {
  beforeEach(async () => {
    if (!enabled) return
    await seedBalance(db, ALICE, market.quoteAsset, 1_000_000_000_000n)
    await seedBalance(db, ALICE, market.baseAsset, TEN_LOTS * 10n)
  })

  test('returns the escrow and records why', async () => {
    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))
    const cancelled = await cancelOrder(deps(), { userId: ALICE, orderId: placed.order.id })

    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancelReason, 'cancelled_by_owner')
    assert.equal((await getBalance(db, ALICE, market.quoteAsset)).available, 1_000_000_000_000n)
  })

  test('refuses to cancel an order that is already finished, rather than answering 200 to nothing', async () => {
    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))
    await cancelOrder(deps(), { userId: ALICE, orderId: placed.order.id })
    await assert.rejects(
      () => cancelOrder(deps(), { userId: ALICE, orderId: placed.order.id }),
      OrderStateError,
    )
  })

  test('will not cancel somebody else’s order, and will not confirm it exists', async () => {
    const placed = await placeOrder(deps(), order({ userId: ALICE, side: 'buy' }))
    await assert.rejects(
      () => cancelOrder(deps(), { userId: BOB, orderId: placed.order.id }),
      (err: unknown) => err instanceof OrderStateError && err.message === 'no such order',
    )
    assert.equal((await getOrder(db, placed.order.id))?.status, 'open')
  })

  test('pulls everything, in one market or in all of them', async () => {
    const otherId = await seedMarket(db)
    // A bid and an offer that do NOT cross. Same price and Alice's own sell would take her own bid
    // and be killed by self-trade prevention, leaving one order to cancel and a passing assertion
    // that proved nothing about mass cancel.
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy', price: PRICE }))
    await placeOrder(deps(), order({ userId: ALICE, side: 'sell', price: PRICE * 3n }))
    await seedBalance(db, ALICE, 'EMBER', 1_000_000_000_000n)
    await placeOrder(deps(), order({ userId: ALICE, side: 'buy', marketId: otherId }))

    const one = await cancelAllOrders(deps(), { userId: ALICE, marketId: otherId })
    assert.equal(one.length, 1)

    const rest = await cancelAllOrders(deps(), { userId: ALICE, marketId: null })
    assert.equal(rest.length, 2)

    // The panic button is idempotent by nature: a second press finds nothing left.
    assert.equal((await cancelAllOrders(deps(), { userId: ALICE, marketId: null })).length, 0)
    const balance = await getBalance(db, ALICE, market.quoteAsset)
    assert.equal(balance.held, 0n)
  })
})

/* ------------------------------------------------------------------ conservation, at length */

describe('conservation', { skip }, () => {
  /**
   * A randomised trading session, seeded.
   *
   * The seed is fixed, so a failure is reproducible and a bisect is meaningful — a session driven by
   * `Math.random()` would make every failure of this test a different failure. What it is looking
   * for cannot be found by any single hand-written case: the interaction of partial fills, price
   * improvement, reserve orders, self-trades, cancellations and fees over hundreds of movements.
   *
   * Every refusal is swallowed on purpose. An order that could not be paid for, priced outside the
   * band or refused by a market rule is a legitimate outcome of a random order, and the property
   * under test is about what the survivors did to the totals.
   */
  test('holds across a randomised session of several hundred movements', async () => {
    const feeMarketId = await seedMarket(db, { makerFeeBps: 10, takerFeeBps: 20, bandBps: 5_000 })
    const feeMarket = (await getMarket(db, feeMarketId)) as Market
    const traders = [ALICE, BOB, CAROL]
    for (const trader of traders) {
      await seedBalance(db, trader, feeMarket.quoteAsset, 100_000_000_000_000n)
      await seedBalance(db, trader, feeMarket.baseAsset, TEN_LOTS * 100n)
    }

    const baseBefore = await assetInCustody(db, feeMarket.baseAsset)
    const quoteBefore = await assetInCustody(db, feeMarket.quoteAsset)
    const random = seededRandom(20_260_807)
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T

    let placed = 0
    let refused = 0
    for (let i = 0; i < 250; i += 1) {
      const userId = pick(traders)
      const side = pick(['buy', 'sell'] as const)
      const marketish = random() < 0.25
      const price = TICK * BigInt(1 + Math.floor(random() * 8))
      const qty = LOT * BigInt(1 + Math.floor(random() * 12))
      const input = order({
        userId,
        side,
        marketId: feeMarketId,
        type: marketish ? 'market' : 'limit',
        price: marketish ? null : price,
        qty: marketish && side === 'buy' ? null : qty,
        quoteQty: marketish && side === 'buy' ? notional(qty, price) : null,
        tif: marketish ? 'gtc' : pick(['gtc', 'gtc', 'ioc', 'fok'] as const),
        stp: pick(['cancel_taker', 'cancel_maker', 'decrement_and_cancel'] as const),
        displayQty: !marketish && random() < 0.2 ? LOT : null,
      })
      try {
        await placeOrder(deps(), input)
        placed += 1
      } catch (err) {
        if (err instanceof OrderRejectedError || err instanceof InsufficientFundsError) {
          refused += 1
          continue
        }
        throw err
      }
      if (random() < 0.15) await cancelAllOrders(deps(), { userId, marketId: feeMarketId })
    }

    // The session has to have actually traded, or the invariant is being asserted over nothing.
    const tape = await recentTrades(db, feeMarketId, 1_000)
    assert.ok(placed > 100, `only ${placed} orders survived (${refused} refused)`)
    assert.ok(tape.length > 20, `only ${tape.length} trades printed`)

    assert.equal(await assetInCustody(db, feeMarket.baseAsset), baseBefore)
    assert.equal(await assetInCustody(db, feeMarket.quoteAsset), quoteBefore)

    // And nobody is holding an escrow for an order that is no longer live: the two would drift apart
    // silently, because a stale hold looks exactly like a customer with less money than they have.
    const stranded = await sql<{ n: number }[]>`
      select count(*)::int as n from orders
       where status not in ('open','pending_trigger') and held_amount <> 0
    `
    assert.equal(stranded[0]?.n, 0)

    const heldByOrders = await sql<{ total: string | null }[]>`
      select sum(held_amount) as total from orders
       where market_id = ${feeMarketId} and held_asset = ${feeMarket.baseAsset}
    `
    const heldByAccounts = await sql<{ total: string | null }[]>`
      select sum(held) as total from exchange_accounts where asset = ${feeMarket.baseAsset}
    `
    // The order rows and the accounts are two independent records of the same reservation. They are
    // written in the same transaction and must therefore agree exactly; if they can disagree, one of
    // them is being updated on a path the other is not.
    assert.equal(BigInt(heldByOrders[0]?.total ?? '0'), BigInt(heldByAccounts[0]?.total ?? '0'))
  })
})
