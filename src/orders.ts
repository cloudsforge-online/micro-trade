/**
 * The order row: its shape, its lifecycle vocabulary, and every read of it.
 *
 * Writes live in `src/exchange.ts`, because every write to an order happens under a market lock and
 * alongside a balance movement, and separating the two halves of that would produce a function that
 * looks safe to call on its own and is not.
 *
 * ## The statuses, and why `pending_trigger` is one of them
 *
 *   `pending_trigger` — a stop order whose trigger has not fired. It is NOT on the book, it takes
 *                       no queue position, and it is invisible to every other participant. Its
 *                       escrow is already held, which is the point: a stop that cannot pay when it
 *                       fires is not a stop.
 *   `open`            — on the book, matchable, `remaining > 0`.
 *   `filled`          — `remaining = 0` and it got there by trading.
 *   `cancelled`       — stopped early: by the customer, by self-trade prevention, by an IOC
 *                       remainder, or by the market being emptied.
 *   `rejected`        — never lived. A post-only that would have crossed, a fill-or-kill that could
 *                       not fill. Recorded rather than thrown away, so a customer can see that the
 *                       exchange received the order and why it refused it.
 *   `expired`         — a GTD order that reached its time.
 *
 * `cancelled` and `rejected` are kept apart deliberately. "We stopped your order" and "we never
 * started it" are different answers to the same question, and collapsing them is how a customer
 * ends up believing a post-only order rested when it never did.
 */

import { amountFrom } from './money.ts'
import type { OrderType, RestingOrder, Side, StpMode, TimeInForce } from './matching.ts'
import type { Db, Tx } from './outbox.ts'

export type OrderStatus =
  | 'pending_trigger'
  | 'open'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired'

/** The statuses in which an order still owns an escrow and can still trade or be cancelled. */
export const LIVE_STATUSES: readonly OrderStatus[] = Object.freeze(['pending_trigger', 'open'])

export type OrderEventKind =
  | 'accepted'
  | 'triggered'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'reduced'

export interface OrderRecord {
  readonly id: string
  readonly marketId: string
  readonly userId: string
  readonly sequence: bigint
  readonly clientOrderId: string | null
  readonly side: Side
  readonly type: OrderType | 'stop_limit' | 'stop_market'
  readonly price: bigint | null
  readonly stopPrice: bigint | null
  readonly tif: TimeInForce
  readonly postOnly: boolean
  readonly stp: StpMode
  readonly qty: bigint | null
  readonly quoteQty: bigint | null
  readonly displayQty: bigint | null
  readonly remaining: bigint
  readonly filledQty: bigint
  readonly filledQuoteQty: bigint
  readonly feeBase: bigint
  readonly feeQuote: bigint
  readonly heldAsset: string | null
  readonly heldAmount: bigint
  readonly status: OrderStatus
  readonly cancelReason: string | null
  readonly expiresAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface OrderRow {
  readonly id: string
  readonly market_id: string
  readonly user_id: string
  readonly sequence: string | number
  readonly client_order_id: string | null
  readonly side: string
  readonly type: string
  readonly price: string | null
  readonly stop_price: string | null
  readonly tif: string
  readonly post_only: boolean
  readonly stp: string
  readonly qty: string | null
  readonly quote_qty: string | null
  readonly display_qty: string | null
  readonly remaining: string
  readonly filled_qty: string
  readonly filled_quote_qty: string
  readonly fee_base: string
  readonly fee_quote: string
  readonly held_asset: string | null
  readonly held_amount: string
  readonly status: string
  readonly cancel_reason: string | null
  readonly expires_at: Date | null
  readonly created_at: Date
  readonly updated_at: Date
}

export const ORDER_COLUMNS = `id, market_id, user_id, sequence, client_order_id, side, type, price,
  stop_price, tif, post_only, stp, qty, quote_qty, display_qty, remaining, filled_qty,
  filled_quote_qty, fee_base, fee_quote, held_asset, held_amount, status, cancel_reason,
  expires_at, created_at, updated_at`

export const toOrder = (row: OrderRow): OrderRecord => ({
  id: row.id,
  marketId: row.market_id,
  userId: row.user_id,
  sequence: BigInt(row.sequence),
  clientOrderId: row.client_order_id,
  side: row.side as Side,
  type: row.type as OrderRecord['type'],
  price: row.price === null ? null : amountFrom(row.price),
  stopPrice: row.stop_price === null ? null : amountFrom(row.stop_price),
  tif: row.tif as TimeInForce,
  postOnly: row.post_only,
  stp: row.stp as StpMode,
  qty: row.qty === null ? null : amountFrom(row.qty),
  quoteQty: row.quote_qty === null ? null : amountFrom(row.quote_qty),
  displayQty: row.display_qty === null ? null : amountFrom(row.display_qty),
  remaining: amountFrom(row.remaining),
  filledQty: amountFrom(row.filled_qty),
  filledQuoteQty: amountFrom(row.filled_quote_qty),
  feeBase: amountFrom(row.fee_base),
  feeQuote: amountFrom(row.fee_quote),
  heldAsset: row.held_asset,
  heldAmount: amountFrom(row.held_amount),
  status: row.status as OrderStatus,
  cancelReason: row.cancel_reason,
  expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
})

/**
 * The average price this order traded at, or `null` if it never traded.
 *
 * Quote per whole base unit, computed from the totals rather than averaged across fills — an
 * average of averages is wrong whenever the fills were different sizes, which is most of the time.
 * Derived on read and never stored, because a stored average is a number that can disagree with the
 * fills it came from.
 */
export function averagePrice(order: OrderRecord, baseUnit: bigint): bigint | null {
  if (order.filledQty <= 0n) return null
  return (order.filledQuoteQty * baseUnit) / order.filledQty
}

export async function getOrder(sql: Db | Tx, id: string): Promise<OrderRecord | null> {
  const rows = await sql<OrderRow[]>`select ${sql.unsafe(ORDER_COLUMNS)} from orders where id = ${id}`
  const row = rows[0]
  return row ? toOrder(row) : null
}

/**
 * One order, but only if it belongs to the caller.
 *
 * The ownership filter is in the WHERE clause rather than in a check afterwards, so somebody else's
 * order is a 404 and not a 403 — a 403 confirms the id exists, which is enough to enumerate the
 * exchange's order ids.
 */
export async function getOwnedOrder(sql: Db, id: string, userId: string): Promise<OrderRecord | null> {
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLUMNS)} from orders where id = ${id} and user_id = ${userId}
  `
  const row = rows[0]
  return row ? toOrder(row) : null
}

export interface OrderQuery {
  readonly userId: string
  readonly marketId?: string | undefined
  readonly open?: boolean | undefined
  readonly limit: number
}

export async function listOrders(sql: Db, query: OrderQuery): Promise<readonly OrderRecord[]> {
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLUMNS)} from orders
     where user_id = ${query.userId}
       and (${query.marketId ?? null}::uuid is null or market_id = ${query.marketId ?? null}::uuid)
       and (${query.open ?? false} = false or status in ('pending_trigger','open'))
     order by sequence desc
     limit ${query.limit}
  `
  return rows.map(toOrder)
}

/**
 * The book, as the engine wants it.
 *
 * Ordered here as well as sorted in `rankBook`, and that is not redundant: the index
 * `orders_book_idx` is `(market_id, side, price, sequence)`, so asking for it in that order is what
 * makes this an index scan rather than a sort of every open order in the market. `rankBook` then
 * imposes the ranking as a property of the ENGINE rather than of a query, so a changed index cannot
 * silently change the matching order.
 *
 * `price is not null` is load-bearing and is not merely a tidy-up. A market order is INSERTED with
 * status `open` and no price, and `matchAndSettle` calls this function before it has matched — so
 * the taker's own row is in this result set. The caller filters it out by id, but that happens after
 * the rows are mapped, and mapping a null price through `amountFrom` throws. Without this predicate
 * every market order placement fails with `RangeError: not an amount: object`; found by the
 * randomised session in `src/exchange.test.ts` on 2026-08-10, which is the first thing in the suite
 * to place a market order against a real table. Semantically it says the right thing too: an order
 * with no price is not at a price level and is not liquidity anyone can match against.
 */
export async function loadBook(tx: Tx, marketId: string): Promise<readonly RestingOrder[]> {
  const rows = await tx<
    { id: string; user_id: string; side: string; price: string; remaining: string; sequence: string | number }[]
  >`
    select id, user_id, side, price, remaining, sequence
      from orders
     where market_id = ${marketId} and status = 'open' and price is not null
     order by side asc, price asc, sequence asc
  `
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    side: row.side as Side,
    price: amountFrom(row.price),
    remaining: amountFrom(row.remaining),
    sequence: BigInt(row.sequence),
  }))
}

/**
 * Markets holding work only the maintenance job can do.
 *
 * Two kinds, and the query asks for both rather than for "every market": a GTD order that has
 * reached its time, and a stop waiting for a trigger. A sweep over every market would take and
 * release the lock on seven markets a minute to do nothing seven times, and would keep doing that
 * as the market list grows. Asking the orders table means the job runs where there is something to
 * run.
 *
 * A `pending_trigger` order is listed whether or not its trigger has fired, because whether it has
 * needs the market's last price and the decision belongs under the lock, not in this predicate. The
 * cost of being wrong here is one lock acquisition that finds nothing to do.
 */
export async function marketsNeedingMaintenance(
  sql: Db,
  now: Date,
  limit: number,
): Promise<readonly string[]> {
  const rows = await sql<{ market_id: string }[]>`
    select distinct market_id from orders
     where (status = 'open' and expires_at is not null and expires_at <= ${now})
        or status = 'pending_trigger'
     limit ${limit}
  `
  return rows.map((row) => row.market_id)
}

export interface OrderEventRecord {
  readonly id: string
  readonly orderId: string
  readonly seq: bigint
  readonly kind: OrderEventKind
  readonly qty: bigint
  readonly price: bigint | null
  readonly detail: string | null
  readonly createdAt: string
}

export async function listOrderEvents(sql: Db, orderId: string): Promise<readonly OrderEventRecord[]> {
  const rows = await sql<
    { id: string; order_id: string; seq: string | number; kind: string; qty: string; price: string | null; detail: string | null; created_at: Date }[]
  >`
    select id, order_id, seq, kind, qty, price, detail, created_at
      from order_events where order_id = ${orderId} order by seq asc
  `
  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    seq: BigInt(row.seq),
    kind: row.kind as OrderEventKind,
    qty: amountFrom(row.qty),
    price: row.price === null ? null : amountFrom(row.price),
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  }))
}

/** Append to the lifecycle. Never updates: the trail is the evidence, so it is write-once. */
export async function recordOrderEvent(
  tx: Tx,
  orderId: string,
  kind: OrderEventKind,
  detail: { qty?: bigint; price?: bigint | null; detail?: string | null } = {},
): Promise<void> {
  await tx`
    insert into order_events (order_id, kind, qty, price, detail)
    values (
      ${orderId}, ${kind}, ${(detail.qty ?? 0n).toString()}::numeric,
      ${detail.price === undefined || detail.price === null ? null : detail.price.toString()}::numeric,
      ${detail.detail ?? null}
    )
  `
}
