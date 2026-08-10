/**
 * The custodial sub-ledger: `available` and `held`, per customer, per asset.
 *
 * ## Why a second set of balances exists at all
 *
 * The ledger is the estate's book of record and it is not fast enough to be inside a matching
 * loop — every fill would be a network call to another service inside a held row lock, and the
 * lock would be held for the duration of the slowest one. So the exchange keeps custody: money
 * crosses into it once (`src/transfers.ts`, a deposit), moves between customers locally at
 * whatever rate the book trades, and crosses back once (a withdrawal). The ledger's escrow account
 * holds the total the whole time, and the sum of every row in this table equals it.
 *
 * That equality is the only thing that makes this safe, so it is asserted rather than assumed:
 * `src/exchange.test.ts` sums both columns across every asset before and after a randomised
 * trading session and requires the totals to be identical. If matching could create or destroy a
 * unit, that test fails; nothing else in the system would notice.
 *
 * ## available and held
 *
 * An open order's money is `held`. It is not spendable and it is not gone — it is exactly the
 * amount that order can consume and no more, computed at placement from the order's own worst case:
 *
 *   * a limit BUY holds `qty * price / 10^base_decimals` quote,
 *   * a limit or market SELL holds `qty` base,
 *   * a market BUY holds the `quoteQty` the customer named.
 *
 * There is no "plus the fee" term in any of those, and that is a consequence of taking the fee in
 * the asset each side RECEIVES: the fee is deducted from money arriving, so it never needs to have
 * been escrowed. An exchange that charges a buyer's fee in quote has to escrow the notional plus a
 * fee estimate, and then has to decide what to do when the estimate was wrong.
 *
 * ## Every movement is a conditional UPDATE
 *
 * Not "read the balance, check it, write it back". Every function here is one statement whose
 * `where` clause carries the check, so two concurrent spends cannot both pass it. The `CHECK
 * (available >= 0 and held >= 0)` in migration 10 is the backstop, and a violation of it is a bug
 * in this file rather than a race — the `where` clause should have refused first, with an error
 * that says which account and how much.
 */

import type { Db, Tx } from './outbox.ts'
import { amountFrom } from './money.ts'

/**
 * Where fee income accumulates: an ordinary row in the same table, under the all-zero user id.
 *
 * A separate table would make the conservation check a join between two schemas and a reconciliation
 * job to go with it. Here the platform is just another holder of the asset, so "nothing was created
 * or destroyed" is one `SUM` over one table — which is precisely why it can be asserted in a test
 * cheaply enough to run on every commit.
 */
export const PLATFORM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000'

export interface Balance {
  readonly userId: string
  readonly asset: string
  readonly available: bigint
  readonly held: bigint
}

interface BalanceRow {
  readonly user_id: string
  readonly asset: string
  readonly available: string
  readonly held: string
}

const toBalance = (row: BalanceRow): Balance => ({
  userId: row.user_id,
  asset: row.asset,
  available: amountFrom(row.available),
  held: amountFrom(row.held),
})

/**
 * Not enough money, said precisely.
 *
 * Carries the asset and both numbers because "insufficient funds" on its own generates a support
 * ticket every single time, and the answer to that ticket is always these three values.
 */
export class InsufficientFundsError extends Error {
  readonly asset: string
  readonly required: bigint
  readonly kind: 'available' | 'held'
  constructor(asset: string, required: bigint, kind: 'available' | 'held') {
    super(`insufficient ${kind} ${asset}: ${required.toString()} required`)
    this.name = 'InsufficientFundsError'
    this.asset = asset
    this.required = required
    this.kind = kind
  }
}

function requirePositive(amount: bigint): void {
  if (amount <= 0n) throw new RangeError('amount must be positive')
}

export async function listBalances(sql: Db, userId: string): Promise<readonly Balance[]> {
  const rows = await sql<BalanceRow[]>`
    select user_id, asset, available, held from exchange_accounts
     where user_id = ${userId} order by asset asc
  `
  return rows.map(toBalance)
}

/**
 * One balance, with a zero for an account that has never existed.
 *
 * Returning a zero rather than `null` is right here: an account that has never held an asset and an
 * account that holds none of it are the same fact to every caller, and forcing each of them to
 * handle a null would only produce four different spellings of the same zero.
 */
export async function getBalance(sql: Db | Tx, userId: string, asset: string): Promise<Balance> {
  const rows = await sql<BalanceRow[]>`
    select user_id, asset, available, held from exchange_accounts
     where user_id = ${userId} and asset = ${asset}
  `
  const row = rows[0]
  return row ? toBalance(row) : { userId, asset, available: 0n, held: 0n }
}

/** Money arriving: a deposit, a fill's proceeds, a released escrow's remainder. */
export async function credit(tx: Tx, userId: string, asset: string, amount: bigint): Promise<void> {
  requirePositive(amount)
  await tx`
    insert into exchange_accounts (user_id, asset, available)
    values (${userId}, ${asset}, ${amount.toString()}::numeric)
    on conflict (user_id, asset) do update
      set available  = exchange_accounts.available + excluded.available,
          updated_at = now()
  `
}

/** Money leaving for good: a withdrawal. The `where` clause is the sufficiency check. */
export async function debitAvailable(tx: Tx, userId: string, asset: string, amount: bigint): Promise<void> {
  requirePositive(amount)
  const rows = await tx`
    update exchange_accounts
       set available = available - ${amount.toString()}::numeric, updated_at = now()
     where user_id = ${userId} and asset = ${asset}
       and available >= ${amount.toString()}::numeric
    returning user_id
  `
  if (rows.length === 0) throw new InsufficientFundsError(asset, amount, 'available')
}

/** Reserve money for an open order. Moves it out of reach without moving it out of the account. */
export async function hold(tx: Tx, userId: string, asset: string, amount: bigint): Promise<void> {
  requirePositive(amount)
  const rows = await tx`
    update exchange_accounts
       set available = available - ${amount.toString()}::numeric,
           held      = held + ${amount.toString()}::numeric,
           updated_at = now()
     where user_id = ${userId} and asset = ${asset}
       and available >= ${amount.toString()}::numeric
    returning user_id
  `
  if (rows.length === 0) throw new InsufficientFundsError(asset, amount, 'available')
}

/** Give a reservation back: a cancellation, or the unspent remainder of a filled order. */
export async function release(tx: Tx, userId: string, asset: string, amount: bigint): Promise<void> {
  requirePositive(amount)
  const rows = await tx`
    update exchange_accounts
       set available = available + ${amount.toString()}::numeric,
           held      = held - ${amount.toString()}::numeric,
           updated_at = now()
     where user_id = ${userId} and asset = ${asset}
       and held >= ${amount.toString()}::numeric
    returning user_id
  `
  if (rows.length === 0) throw new InsufficientFundsError(asset, amount, 'held')
}

/**
 * Spend a reservation: the money leaves the account because the order it was held for filled.
 *
 * Distinct from `debitAvailable` because it comes out of `held`, and distinct from `release`
 * because it does not come back. Conflating any two of the three is how an exchange ends up letting
 * an order spend money it never reserved.
 */
export async function spendHeld(tx: Tx, userId: string, asset: string, amount: bigint): Promise<void> {
  requirePositive(amount)
  const rows = await tx`
    update exchange_accounts
       set held = held - ${amount.toString()}::numeric, updated_at = now()
     where user_id = ${userId} and asset = ${asset}
       and held >= ${amount.toString()}::numeric
    returning user_id
  `
  if (rows.length === 0) throw new InsufficientFundsError(asset, amount, 'held')
}

/** Per-asset totals across every account, platform included. The conservation check reads this. */
export async function assetTotals(sql: Db): Promise<ReadonlyMap<string, bigint>> {
  const rows = await sql<{ asset: string; total: string }[]>`
    select asset, sum(available + held)::text as total from exchange_accounts group by asset
  `
  return new Map(rows.map((row) => [row.asset, amountFrom(row.total)]))
}
