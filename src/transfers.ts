/**
 * The boundary between the customer's ledger wallet and the exchange's custody.
 *
 * These are the ONLY two operations in the exchange that talk to the ledger. Everything between
 * them — every order, every match, every fee — moves money inside `exchange_accounts`, which is why
 * a fill is one local transaction and not a distributed one. The ledger holds the total in an escrow
 * account the whole time, and the sum of `available + held` across every row of
 * `exchange_accounts` for an asset equals what the ledger says is escrowed for it.
 *
 * ## The same three layers as a fill
 *
 * `src/fills.ts` states the argument in full and it is the same one here, so it is not repeated:
 * the row is written FIRST, the ledger key is DERIVED from that row's id, and the application of
 * the outcome is a conditional `UPDATE … WHERE status IN ('pending','unresolved')`. The gap between
 * deciding to move money and having moved it is where a crash costs somebody money, and a row that
 * already exists is what makes the retry a replay instead of a second transfer.
 *
 * ## The two directions are not mirror images
 *
 * A **deposit** debits the wallet and credits the exchange's escrow at the ledger, and only then
 * credits the customer's exchange balance. Wrong order and a crash in between hands out custody
 * money that never arrived.
 *
 * A **withdrawal** debits the customer's exchange balance FIRST, inside the same transaction that
 * writes the row, and only then asks the ledger to move it out of escrow. Wrong order and a
 * customer can withdraw the same balance twice by racing two requests. The asymmetry is deliberate:
 * in both directions the local side is the one that can be made conditional, so the local side goes
 * first when it is a debit and second when it is a credit. Each order errs toward the exchange
 * holding the money rather than toward it being in two places at once.
 *
 * A withdrawal the ledger refuses gives the balance back (`status = 'refused'`). A withdrawal whose
 * outcome is UNKNOWN does not: `unresolved` leaves the debit standing, because crediting it back
 * would be a claim that the money did not move, and that is exactly what is not known.
 */

import { CHAINS, RETIRED_ASSETS, type AssetCode } from '@cloudsforge/contracts-chain'
import { EXCHANGE, userSubject } from '@cloudsforge/contracts-money'
import { amountFrom } from './money.ts'
import { credit, debitAvailable, type Balance } from './accounts.ts'
import {
  LedgerInFlightError,
  LedgerRefusedError,
  LedgerUnavailableError,
  type AccountRef,
  type LedgerClient,
  type PostingRequest,
} from './ledgerclient.ts'
import { withOutbox, type Db, type Tx } from './outbox.ts'
import { SERVICE } from './topics.ts'

/**
 * An asset a customer may move in or out of exchange custody.
 *
 * `CHAINS` is a TOTAL `Record<AssetCode, ChainSpec>` in the contracts package, so membership of it
 * is the estate's own list of assets rather than a second copy of one that can drift. A RETIRED
 * asset is excluded: SHARD still exists in a great many ledger accounts and nothing new may be
 * denominated in it, so accepting a SHARD deposit would be creating new exchange custody in a unit
 * the estate has decided to stop issuing.
 */
export const isTransferableAsset = (value: unknown): value is AssetCode =>
  typeof value === 'string' &&
  Object.hasOwn(CHAINS, value) &&
  !RETIRED_ASSETS.includes(value as AssetCode)

export type TransferDirection = 'deposit' | 'withdrawal'
export type TransferStatus = 'pending' | 'settled' | 'refused' | 'unresolved'

export interface TransferRecord {
  readonly id: string
  readonly userId: string
  readonly asset: string
  readonly direction: TransferDirection
  readonly amount: bigint
  readonly status: TransferStatus
  readonly entryId: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly settledAt: string | null
}

interface TransferRow {
  readonly id: string
  readonly user_id: string
  readonly asset: string
  readonly direction: string
  readonly amount: string
  readonly status: string
  readonly entry_id: string | null
  readonly error: string | null
  readonly created_at: Date
  readonly settled_at: Date | null
}

const COLUMNS = `id, user_id, asset, direction, amount, status, entry_id, error, created_at, settled_at`

export const toTransfer = (row: TransferRow): TransferRecord => ({
  id: row.id,
  userId: row.user_id,
  asset: row.asset,
  direction: row.direction as TransferDirection,
  amount: amountFrom(row.amount),
  status: row.status as TransferStatus,
  entryId: row.entry_id,
  error: row.error,
  createdAt: row.created_at.toISOString(),
  settledAt: row.settled_at === null ? null : row.settled_at.toISOString(),
})

/** `trade:xfer:<row id>`. Derived, so a retry of one row replays rather than moving money twice. */
export const transferIdempotencyKey = (transferId: string): string => `trade:xfer:${transferId}`

/**
 * The postings a transfer makes.
 *
 * Two legs in one asset, so they balance without a clearing account — unlike a fill, which converts
 * between two assets and cannot. The escrow account is subject `exchange`, purpose `escrow`, and it
 * is a LIABILITY: the exchange owes that balance back to the customers whose rows in
 * `exchange_accounts` add up to it.
 *
 * The subject comes from `EXCHANGE` in contracts-money rather than being spelled here, and that is
 * not tidiness. It was the literal `'exchange'` from the day the order book shipped until
 * micro-org#372, and the grammar had no such subject — so `parseAccountSubject` threw inside the
 * ledger's `ensureAccount` and every posting this function makes would have died there, in both
 * directions, for every asset. Nothing caught it: `AccountRef.subject` is a `string` on the wire,
 * and the feature is off behind TRADE_EXCHANGE_ENABLED. Importing the constant is what makes a
 * subject this service invents a compile error instead of a runtime one.
 */
export function transferPostings(input: {
  readonly userId: string
  readonly asset: AssetCode
  readonly direction: TransferDirection
  readonly amount: bigint
}): readonly PostingRequest[] {
  const wallet: AccountRef = {
    subject: userSubject(input.userId),
    assetCode: input.asset,
    purpose: 'available',
    type: 'liability',
  }
  const escrow: AccountRef = {
    subject: EXCHANGE,
    assetCode: input.asset,
    purpose: 'escrow',
    type: 'liability',
  }
  const [from, to] = input.direction === 'deposit' ? [wallet, escrow] : [escrow, wallet]
  return [
    { account: from, direction: 'debit', amount: input.amount, assetCode: input.asset, sequence: 0 },
    { account: to, direction: 'credit', amount: input.amount, assetCode: input.asset, sequence: 1 },
  ]
}

export interface TransferDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly correlationId: string
}

export interface TransferInput {
  readonly userId: string
  readonly asset: AssetCode
  readonly amount: bigint
}

/** Book the intent, and for a withdrawal take the money out of reach in the same statement. */
export async function bookTransfer(
  tx: Tx,
  direction: TransferDirection,
  input: TransferInput,
): Promise<TransferRecord> {
  if (input.amount <= 0n) throw new RangeError('a transfer amount must be positive')
  if (direction === 'withdrawal') {
    // Conditional, and inside this transaction: two racing withdrawals cannot both pass it, and a
    // rollback anywhere below puts the balance back with no compensating write.
    await debitAvailable(tx, input.userId, input.asset, input.amount)
  }
  const rows = await tx<TransferRow[]>`
    insert into exchange_transfers (user_id, asset, direction, amount, status)
    values (${input.userId}, ${input.asset}, ${direction}, ${input.amount.toString()}::numeric, 'pending')
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('transfer insert returned nothing')
  return toTransfer(row)
}

export type TransferOutcome =
  | { readonly status: 'settled'; readonly transfer: TransferRecord; readonly balance: Balance }
  | { readonly status: 'refused'; readonly transfer: TransferRecord }
  | { readonly status: 'unresolved'; readonly transfer: TransferRecord }

/**
 * Post a booked transfer to the ledger and apply it.
 *
 * Safe to call any number of times for one row: the ledger key is derived from the row id, so a
 * repeat replays; the conditional update claims the right to apply it, so a repeat that finds it
 * already applied moves nothing.
 */
export async function settleTransfer(
  deps: TransferDeps,
  transfer: TransferRecord,
): Promise<TransferOutcome> {
  try {
    const entry = await deps.ledger.postEntry({
      kind: 'transfer',
      actor: `user:${transfer.userId}`,
      correlationId: deps.correlationId,
      idempotencyKey: transferIdempotencyKey(transfer.id),
      description: `Exchange ${transfer.direction} ${transfer.amount.toString()} ${transfer.asset}`,
      postings: transferPostings({
        userId: transfer.userId,
        asset: transfer.asset as AssetCode,
        direction: transfer.direction,
        amount: transfer.amount,
      }),
    })
    return await applyTransfer(deps.sql, transfer.id, entry.id)
  } catch (err) {
    if (err instanceof LedgerRefusedError) {
      const refused = await closeTransfer(deps.sql, transfer.id, 'refused', `${err.code}: ${err.message}`)
      return { status: 'refused', transfer: refused ?? transfer }
    }
    if (err instanceof LedgerInFlightError || err instanceof LedgerUnavailableError) {
      const unresolved = await closeTransfer(deps.sql, transfer.id, 'unresolved', err.message)
      return { status: 'unresolved', transfer: unresolved ?? transfer }
    }
    throw err
  }
}

/**
 * Claim the transfer and move the exchange balance.
 *
 * The `where status in ('pending','unresolved')` is the claim: a second caller updates zero rows
 * and returns without crediting anything. A deposit credits here; a withdrawal already debited when
 * it was booked, so there is nothing left to move and the row simply closes.
 */
export async function applyTransfer(
  sql: Db,
  transferId: string,
  entryId: string,
): Promise<TransferOutcome> {
  const applied = await withOutbox(sql, SERVICE, async (tx, publish) => {
    const rows = await tx<TransferRow[]>`
      update exchange_transfers
         set status = 'settled', entry_id = ${entryId}, error = null, settled_at = now()
       where id = ${transferId} and status in ('pending','unresolved')
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) {
      const existing = await tx<TransferRow[]>`select ${tx.unsafe(COLUMNS)} from exchange_transfers where id = ${transferId}`
      return { claimed: false as const, row: existing[0] ?? null }
    }
    const transfer = toTransfer(row)
    if (transfer.direction === 'deposit') {
      await credit(tx, transfer.userId, transfer.asset, transfer.amount)
    }
    // ── `assetCode`, NOT `asset` — micro-org#367 ─────────────────────────────────────────────────
    //
    // This field was spelled `asset` from the day the topic was registered, and it is the only
    // asset-bearing payload on the estate that spells it that way. The cost is entirely in the
    // consumer: `activity/src/classify.ts` fills its `asset_code` COLUMN from a payload key called
    // `assetCode` and from nothing else, so every exchange transfer landed with `asset_code` null
    // and could not be filtered or grouped by asset. That file's own comment argues the point at
    // length and then declines to invent a second spelling for the column, which was the right
    // call: the producer is the half that is wrong.
    //
    // Renamed rather than sent twice. A payload carrying both spellings is a payload that has to
    // carry both for ever, and the second one is exactly the thing a reader would later copy.
    //
    // No migration and no backfill, and that is measured rather than assumed: mainnet
    // `trade.exchange_transfers` held zero rows and `TRADE_EXCHANGE_ENABLED` is set on neither
    // network (re-measured 2026-08-12, unchanged since the exchange-subject audit recorded it), so
    // there is no history under the old spelling and no consumer row to correct. The window in
    // which this rename is free is the one it is being made in.
    publish({
      topic: 'trade.transfer.settled',
      key: transfer.id,
      payload: {
        transferId: transfer.id,
        userId: transfer.userId,
        assetCode: transfer.asset,
        direction: transfer.direction,
        amount: transfer.amount.toString(),
        entryId,
      },
    })
    return { claimed: true as const, row }
  })
  const row = applied.row
  if (!row) throw new Error('the transfer disappeared while it was being settled')
  const transfer = toTransfer(row)
  const balance = await currentBalance(sql, transfer.userId, transfer.asset)
  return { status: 'settled', transfer, balance }
}

async function currentBalance(sql: Db, userId: string, asset: string): Promise<Balance> {
  const rows = await sql<{ available: string; held: string }[]>`
    select available, held from exchange_accounts where user_id = ${userId} and asset = ${asset}
  `
  const row = rows[0]
  return {
    userId,
    asset,
    available: row ? amountFrom(row.available) : 0n,
    held: row ? amountFrom(row.held) : 0n,
  }
}

/**
 * Close a transfer that will not settle.
 *
 * A REFUSED withdrawal gives the balance back, because the ledger looked and said no and nothing
 * moved. An UNRESOLVED one does not, and that asymmetry is the whole point of having two words for
 * it: crediting back on an unknown outcome is a claim, and the claim would be wrong exactly when it
 * cost the most.
 */
export async function closeTransfer(
  sql: Db,
  transferId: string,
  status: 'refused' | 'unresolved',
  reason: string,
): Promise<TransferRecord | null> {
  return withOutbox(sql, SERVICE, async (tx) => {
    const rows = await tx<TransferRow[]>`
      update exchange_transfers
         set status = ${status}, error = ${reason.slice(0, 2_000)},
             settled_at = ${status === 'refused' ? new Date() : null}
       where id = ${transferId} and status in ('pending','unresolved')
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) return null
    const transfer = toTransfer(row)
    if (status === 'refused' && transfer.direction === 'withdrawal') {
      await credit(tx, transfer.userId, transfer.asset, transfer.amount)
    }
    return transfer
  })
}

export async function getTransfer(sql: Db, id: string, userId: string): Promise<TransferRecord | null> {
  const rows = await sql<TransferRow[]>`
    select ${sql.unsafe(COLUMNS)} from exchange_transfers where id = ${id} and user_id = ${userId}
  `
  const row = rows[0]
  return row ? toTransfer(row) : null
}

export async function listTransfers(sql: Db, userId: string, limit: number): Promise<readonly TransferRecord[]> {
  const rows = await sql<TransferRow[]>`
    select ${sql.unsafe(COLUMNS)} from exchange_transfers
     where user_id = ${userId} order by created_at desc limit ${limit}
  `
  return rows.map(toTransfer)
}

/** One transfer by id, with no owner filter — for the job, which acts for nobody. */
export async function getTransferById(sql: Db, id: string): Promise<TransferRecord | null> {
  const rows = await sql<TransferRow[]>`
    select ${sql.unsafe(COLUMNS)} from exchange_transfers where id = ${id}
  `
  const row = rows[0]
  return row ? toTransfer(row) : null
}

/**
 * Transfers whose outcome is still unknown, for the job that asks the ledger again.
 *
 * `olderThan` is the whole reason this takes a time rather than just a limit. The request that
 * booked a transfer settles it inline, so a row a second old is almost always one an in-flight
 * request is already working on. Enqueuing it would be harmless — the ledger key is derived and the
 * apply is conditional — but it would mean the sweep spends its whole budget racing requests instead
 * of finding the transfers that were actually abandoned by a crash.
 */
export async function openTransfers(
  sql: Db,
  olderThan: Date,
  limit: number,
): Promise<readonly TransferRecord[]> {
  const rows = await sql<TransferRow[]>`
    select ${sql.unsafe(COLUMNS)} from exchange_transfers
     where status in ('pending','unresolved') and created_at < ${olderThan}
     order by created_at asc limit ${limit}
  `
  return rows.map(toTransfer)
}
