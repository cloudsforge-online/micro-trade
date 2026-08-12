/**
 * The boundary between the customer's ledger wallet and exchange custody.
 *
 * These are the only two operations in the exchange that talk to the ledger, so they are the only
 * two places where a crash can leave money in one system and not the other. Every test here is about
 * that gap: what the row says while the outcome is unknown, and what a retry does when it arrives.
 *
 * The fake ledger's `commitThenLoseAnswer` is the case worth having a database for. It is a timeout
 * that fired after the entry committed — the outcome that a design without a derived key gets wrong,
 * and the one no amount of unit testing the happy path will find.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach, describe } from 'node:test'
import type postgres from 'postgres'
import {
  applyTransfer,
  bookTransfer,
  closeTransfer,
  getTransfer,
  getTransferById,
  isTransferableAsset,
  listTransfers,
  openTransfers,
  settleTransfer,
  transferIdempotencyKey,
  transferPostings,
  type TransferRecord,
} from './transfers.ts'
import { EXCHANGE, parseAccountSubject } from '@cloudsforge/contracts-money'
import { InsufficientFundsError, getBalance } from './accounts.ts'
import { buildEnvelope, withOutbox, type Db } from './outbox.ts'
import { SERVICE, envelopeDefects } from './topics.ts'
import {
  ALICE,
  BOB,
  assetInCustody,
  enabled,
  fakeLedger,
  migrateTestDb,
  openDb,
  resetTrade,
  seedBalance,
  skip,
  type FakeLedger,
} from './testsupport.ts'

/**
 * The relay's own row shape, restated here because `outbox.ts` keeps it private — the same
 * structural copy `bots.test.ts` carries, and for the same reason: the point of reading a REAL row
 * back out of the table and building the envelope from it is that nothing in this file gets to
 * invent what a producer sends. A fixture envelope proves a fixture.
 */
interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger

const CORRELATION = '00000000-0000-4000-8000-00000000c0de'

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetTrade(sql)
  ledger = fakeLedger()
})

after(async () => {
  if (enabled) await sql.end({ timeout: 5 })
})

const deps = (): { sql: Db; ledger: FakeLedger; correlationId: string } => ({
  sql: db,
  ledger,
  correlationId: CORRELATION,
})

/** Book a transfer on its own transaction, the way the route's idempotency claim does. */
async function book(
  direction: 'deposit' | 'withdrawal',
  userId: string,
  asset: 'BTC',
  amount: bigint,
): Promise<TransferRecord> {
  return withOutbox(db, SERVICE, async (tx) => bookTransfer(tx, direction, { userId, asset, amount }))
}

/* ------------------------------------------------------------------ what may move */

describe('the assets a customer may move', { skip }, () => {
  test('are the estate’s own list, not a second copy of it', () => {
    assert.equal(isTransferableAsset('BTC'), true)
    assert.equal(isTransferableAsset('EMBER'), true)
    assert.equal(isTransferableAsset('not-an-asset'), false)
    assert.equal(isTransferableAsset(7), false)
    assert.equal(isTransferableAsset(null), false)
  })

  test('exclude a retired asset, because a deposit would create custody in a unit nobody may issue', () => {
    // SHARD still exists in a great many ledger accounts, so this is not "unknown asset" — it is a
    // deliberate one-way door. Accepting one would put the exchange in the position of owing a
    // balance back in a denomination the estate has stopped issuing.
    assert.equal(isTransferableAsset('SHARD'), false)
  })
})

describe('the postings a transfer makes', { skip }, () => {
  test('are two legs in one asset, so they balance without a clearing account', () => {
    const postings = transferPostings({ userId: ALICE, asset: 'BTC', direction: 'deposit', amount: 500n })
    assert.equal(postings.length, 2)
    assert.deepEqual(
      postings.map((p) => [p.account.subject, p.direction]),
      [[`user:${ALICE}`, 'debit'], ['exchange', 'credit']],
    )
    assert.ok(postings.every((p) => p.assetCode === 'BTC' && p.amount === 500n))
  })

  test('run the other way for a withdrawal', () => {
    const postings = transferPostings({ userId: ALICE, asset: 'BTC', direction: 'withdrawal', amount: 500n })
    assert.deepEqual(
      postings.map((p) => [p.account.subject, p.direction]),
      [['exchange', 'debit'], [`user:${ALICE}`, 'credit']],
    )
  })

  test('are keyed on the row id, so a retry replays instead of moving money twice', () => {
    assert.equal(transferIdempotencyKey('abc'), 'trade:xfer:abc')
  })
})

/**
 * micro-org#372, and NOT gated on a database — that is the whole point of putting it in its own
 * group. `transferPostings` is pure, and every case above it is skipped without postgres, so the
 * defect this covers had no test that could run in CI at all.
 *
 * The defect: the escrow leg named `subject: 'exchange'` and the estate's subject grammar had no
 * such subject, so `parseAccountSubject` threw inside micro-ledger's `ensureAccount` and every
 * posting this function makes died there. `AccountRef.subject` is a `string` on the wire, so
 * nothing in the compiler objected, and the order book is off behind TRADE_EXCHANGE_ENABLED, so
 * nothing in production had tried it. Asserting the SUBJECT PARSES is the check that would have
 * caught it; asserting it equals `'exchange'`, as the cases above do, is not — that is the
 * spelling agreeing with itself.
 */
describe('the subjects a transfer names are ones the ledger will accept', () => {
  test('both legs parse, both directions, and the escrow leg is the exchange omnibus', () => {
    for (const direction of ['deposit', 'withdrawal'] as const) {
      const postings = transferPostings({ userId: ALICE, asset: 'BTC', direction, amount: 500n })
      for (const posting of postings) {
        assert.doesNotThrow(
          () => parseAccountSubject(posting.account.subject),
          `${posting.account.subject} is not an account subject — micro-ledger's ensureAccount throws on it`,
        )
      }
      const escrow = postings.find((p) => p.account.subject === EXCHANGE)
      assert.ok(escrow, 'one leg must be the exchange escrow')
      assert.deepEqual(parseAccountSubject(escrow.account.subject), { kind: 'exchange' })
      // Liability, and it matters: `reconcile.ts` sums liabilities by TYPE with no subject filter,
      // so Σ liabilities is unchanged when a balance moves from a user wallet into escrow. An
      // `equity` or `clearing` escrow would have broken the reconciliation invariant instead.
      assert.equal(escrow.account.type, 'liability')
      assert.equal(escrow.account.purpose, 'escrow')
    }
  })
})

/* ------------------------------------------------------------------ deposits */

describe('a deposit', { skip }, () => {
  test('credits exchange custody only after the ledger has moved the money', async () => {
    const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
    // Booked, and NOTHING credited yet. A deposit that credited on intent would hand out custody
    // money that had not arrived, and a crash between the two would make that permanent.
    assert.equal(transfer.status, 'pending')
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 0n)
    assert.equal(await assetInCustody(db, 'BTC'), 0n)

    const outcome = await settleTransfer(deps(), transfer)
    assert.equal(outcome.status, 'settled')
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 1_000n)
    assert.equal(await assetInCustody(db, 'BTC'), 1_000n)
  })

  test('credits once however many times it is settled', async () => {
    const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
    await settleTransfer(deps(), transfer)
    await settleTransfer(deps(), transfer)
    await settleTransfer(deps(), transfer)

    // The `where status in ('pending','unresolved')` is the claim. A second caller updates zero rows
    // and returns without crediting, which is what makes the recovery job safe to run at any time.
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 1_000n)
    assert.equal(ledger.entries.length, 1, 'the ledger committed more than one entry')
  })

  test('refuses an amount that is not positive, before it books anything', async () => {
    await assert.rejects(() => book('deposit', ALICE, 'BTC', 0n), RangeError)
    await assert.rejects(() => book('deposit', ALICE, 'BTC', -1n), RangeError)
    const rows = await sql`select count(*)::int as n from exchange_transfers`
    assert.equal((rows[0] as { n: number }).n, 0)
  })

  test('is left unresolved by a ledger that does not answer, and settles on the next pass', async () => {
    const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
    ledger.failNext(1)
    const unresolved = await settleTransfer(deps(), transfer)
    assert.equal(unresolved.status, 'unresolved')
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 0n)

    const settled = await settleTransfer(deps(), await current(transfer.id))
    assert.equal(settled.status, 'settled')
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 1_000n)
  })

  test('survives a ledger that commits and loses the answer', async () => {
    const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
    ledger.commitThenLoseAnswer()
    const lost = await settleTransfer(deps(), transfer)
    assert.equal(lost.status, 'unresolved')

    const recovered = await settleTransfer(deps(), await current(transfer.id))
    assert.equal(recovered.status, 'settled')
    // One entry, not two: the key is derived from the row id, so the second attempt sent the SAME
    // key and the ledger replayed rather than posting a second deposit.
    assert.equal(ledger.entries.length, 1)
    assert.equal(new Set(ledger.keys).size, 1)
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 1_000n)
  })
})

/* ------------------------------------------------------------------ the event */

/**
 * The settled transfer names its asset the way the estate spells it — micro-org#367.
 *
 * ## The mutation this kills
 *
 * Spelling the payload key `asset`, which is what shipped and what every exchange transfer would
 * have carried. Nothing in this repository could see the cost, because the cost is entirely one
 * repository downstream: `activity/src/classify.ts` fills its `asset_code` COLUMN from a payload
 * key called `assetCode` and from nothing else, so `asset_code` was null on every exchange
 * transfer and the rows could not be filtered or grouped by the asset they moved. This service's
 * own suite was green throughout — the row was right, the ledger was right, and the field name was
 * the only thing wrong.
 *
 * So the assertion is on the OUTBOX ROW and it is a pair: the estate's spelling is present AND the
 * old one is gone. Asserting only the first passes against a payload that carries both, which is
 * the shape somebody reaches for when they do not want to break a consumer — and which would make
 * the wrong spelling permanent, because the second key is the one the next reader copies.
 *
 * `envelopeDefects` is run over it for the same reason `bots.test.ts` runs it over a fill: whether
 * the estate can read this event is the contract's answer, not this file's.
 */
test('a settled transfer names its asset assetCode, which is the only spelling activity reads', { skip }, async () => {
  const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
  assert.equal((await settleTransfer(deps(), transfer)).status, 'settled')

  const rows = await sql<OutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox where topic = 'trade.transfer.settled'
  `
  assert.equal(rows.length, 1, 'the transfer settled and the estate was told nothing')

  const envelope = buildEnvelope(rows[0]!)
  assert.equal(envelope.payload['assetCode'], 'BTC', 'activity fills asset_code from assetCode and from nothing else')
  assert.equal(
    Object.hasOwn(envelope.payload, 'asset'),
    false,
    'the old spelling is still on the wire, so the wrong key outlives the fix',
  )
  assert.equal(envelope.key, rows[0]!.payload['transferId'], 'the registry keys this topic by the transfer')
  assert.deepEqual(
    envelopeDefects(JSON.parse(JSON.stringify(envelope))),
    [],
    'a transfer event every consumer in the estate would refuse',
  )
})

/* ------------------------------------------------------------------ withdrawals */

describe('a withdrawal', { skip }, () => {
  beforeEach(async () => {
    if (!enabled) return
    await seedBalance(db, ALICE, 'BTC', 5_000n)
  })

  test('takes the balance out of reach in the same statement that books it', async () => {
    const transfer = await book('withdrawal', ALICE, 'BTC', 1_000n)
    assert.equal(transfer.status, 'pending')
    // Debited already. The asymmetry with a deposit is deliberate: the local side goes first when it
    // is a debit, so two racing withdrawals cannot both pass the conditional.
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 4_000n)

    const outcome = await settleTransfer(deps(), transfer)
    assert.equal(outcome.status, 'settled')
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 4_000n)
  })

  test('cannot be booked twice for a balance that only covers it once', async () => {
    await book('withdrawal', ALICE, 'BTC', 5_000n)
    await assert.rejects(() => book('withdrawal', ALICE, 'BTC', 1n), InsufficientFundsError)
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 0n)
  })

  test('gives the balance back when the ledger looks and says no', async () => {
    ledger.setAssetBalance('exchange', 'BTC', 0n)
    const transfer = await book('withdrawal', ALICE, 'BTC', 1_000n)
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 4_000n)

    const outcome = await settleTransfer(deps(), transfer)
    assert.equal(outcome.status, 'refused')
    assert.equal(outcome.transfer.status, 'refused')
    assert.ok(outcome.transfer.error)
    // Refused means the ledger looked and nothing moved, so giving it back is a statement of fact.
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 5_000n)
  })

  test('does NOT give the balance back while the outcome is unknown', async () => {
    const transfer = await book('withdrawal', ALICE, 'BTC', 1_000n)
    ledger.commitThenLoseAnswer()
    const outcome = await settleTransfer(deps(), transfer)

    assert.equal(outcome.status, 'unresolved')
    // The money may well have left. Crediting it back would be a claim that it did not, and that
    // claim is wrong exactly when it costs the most — the entry in this test DID commit.
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 4_000n)

    const recovered = await settleTransfer(deps(), await current(transfer.id))
    assert.equal(recovered.status, 'settled')
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 4_000n)
    assert.equal(ledger.entries.length, 1)
  })

  test('is refunded once and only once when it is closed twice', async () => {
    const transfer = await book('withdrawal', ALICE, 'BTC', 1_000n)
    await closeTransfer(db, transfer.id, 'refused', 'first')
    const second = await closeTransfer(db, transfer.id, 'refused', 'second')
    assert.equal(second, null)
    assert.equal((await getBalance(db, ALICE, 'BTC')).available, 5_000n)
  })
})

/* ------------------------------------------------------------------ reading them back */

describe('reading transfers back', { skip }, () => {
  test('scopes a lookup to its owner, and the recovery job’s lookup to nobody', async () => {
    const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
    assert.ok(await getTransfer(db, transfer.id, ALICE))
    // Not "403": a customer asking about somebody else's transfer is told there is no such row,
    // which is the same answer they get for an id that never existed.
    assert.equal(await getTransfer(db, transfer.id, BOB), null)
    // The job acts for nobody, so it has a lookup with no owner filter at all.
    assert.ok(await getTransferById(db, transfer.id))
  })

  test('lists a customer’s own, newest first', async () => {
    await book('deposit', ALICE, 'BTC', 1n)
    await book('deposit', ALICE, 'BTC', 2n)
    await book('deposit', BOB, 'BTC', 3n)

    const mine = await listTransfers(db, ALICE, 10)
    assert.equal(mine.length, 2)
    assert.ok(mine.every((t) => t.userId === ALICE))
  })

  test('finds the ones a crash abandoned, and not the ones a request is still working on', async () => {
    const fresh = await book('deposit', ALICE, 'BTC', 1_000n)
    // A row a second old is almost always one an in-flight request is settling inline. Sweeping it
    // would be harmless but would spend the job's whole budget racing requests instead of finding
    // what was actually abandoned.
    assert.equal((await openTransfers(db, new Date(Date.now() - 60_000), 10)).length, 0)

    await sql`update exchange_transfers set created_at = now() - interval '1 hour' where id = ${fresh.id}`
    const stale = await openTransfers(db, new Date(Date.now() - 60_000), 10)
    assert.equal(stale.length, 1)
    assert.equal(stale[0]?.id, fresh.id)

    await settleTransfer(deps(), stale[0] as TransferRecord)
    assert.equal((await openTransfers(db, new Date(Date.now() - 60_000), 10)).length, 0)
  })

  test('applies an entry id the job already has, without asking the ledger again', async () => {
    const transfer = await book('deposit', ALICE, 'BTC', 1_000n)
    const outcome = await applyTransfer(db, transfer.id, '00000000-0000-4000-8000-000000000042')
    assert.equal(outcome.status, 'settled')
    assert.equal(outcome.transfer.entryId, '00000000-0000-4000-8000-000000000042')
    assert.equal(ledger.entries.length, 0)
  })
})

async function current(id: string): Promise<TransferRecord> {
  const row = await getTransferById(db, id)
  if (!row) throw new Error('the transfer disappeared')
  return row
}
