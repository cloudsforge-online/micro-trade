/**
 * The schema, against a real Postgres.
 *
 * These tests exist because a constraint that is never exercised is a comment. Two of them —
 * `fee_settlements_bot_period_uniq` and `fills_bot_bar_side_uniq` — are the reason this repository
 * exists, and both are asserted here at the DDL level as well as through the code paths that rely on
 * them in `fees.test.ts` and `fills.test.ts`.
 *
 * The migrator is exercised **as a migrator**, on an empty database, exactly as a deploy runs it. A
 * schema created by the test suite instead would never prove the one-shot job works.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { MIGRATIONS, SCHEMA_VERSION, TABLES, BASELINE_VERSION } from './migrations.ts'
import { enabled, migrateTestDb, openDb, resetTrade, skip, ALICE, seedSeries, makeBars } from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let db: Db

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetTrade(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

/* ------------------------------------------------------------------ the migration set itself */

test('migration versions are unique and monotonic, so two databases cannot disagree about a version', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length)
})

test('the asserted schema version is the highest migration, so a deploy cannot serve on an old schema', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines at zero, so no migration is recorded as applied without running', () => {
  assert.equal(BASELINE_VERSION, 0)
})

test('every migration has a name, so an operator reading schema_migrations can tell what ran', () => {
  for (const migration of MIGRATIONS) {
    assert.ok(migration.name.length > 0, `migration ${migration.version} has no name`)
    assert.ok(migration.up.length > 0, `migration ${migration.version} has no SQL`)
  }
})

test('every table the harness truncates actually exists, so a reset cannot silently skip one', { skip }, async () => {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'
  `
  const present = new Set(rows.map((row) => row.table_name))
  for (const table of TABLES) assert.ok(present.has(table), `${table} is truncated but does not exist`)
  assert.ok(present.has('jobs'))
  assert.ok(present.has('schema_migrations'))
})

test('running the migrator twice is a no-op, so a re-run deploy does not fail', { skip }, async () => {
  await migrateTestDb(sql)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from schema_migrations`
  assert.equal(rows[0]?.n, MIGRATIONS.length)
})

/* ------------------------------------------------------------------ the constraints that matter */

test('one settlement row per bot per period, enforced by the database', { skip }, async () => {
  // THE constraint. Without it, two attempts at one settlement produce two rows and therefore two
  // idempotency keys, and the upstream honours both — which is the frozen service's live defect.
  const botId = await aBot()
  await insertSettlement(botId, 7n)
  await assert.rejects(
    () => insertSettlement(botId, 7n),
    (err: unknown) => String(err).includes('fee_settlements_bot_period_uniq'),
  )
  // A different period is a different settlement and is allowed.
  await assert.doesNotReject(() => insertSettlement(botId, 8n))
})

test('one fill per bot per bar per side, enforced by the database', { skip }, async () => {
  const botId = await aBot()
  await insertFill(botId, 1_700_000_400, 'buy')
  await assert.rejects(
    () => insertFill(botId, 1_700_000_400, 'buy'),
    (err: unknown) => String(err).includes('fills_bot_bar_side_uniq'),
  )
  // The other side of the same bar, and the same side of another bar, are both different fills.
  await assert.doesNotReject(() => insertFill(botId, 1_700_000_400, 'sell'))
  await assert.doesNotReject(() => insertFill(botId, 1_700_004_000, 'buy'))
})

test('a settlement cannot claim to have collected more than it attempted', { skip }, async () => {
  const botId = await aBot()
  await assert.rejects(
    () => sql`
      insert into fee_settlements (bot_id, user_id, period, equity, high_water_mark, gain, fee, attempted, collected, status)
      values (${botId}, ${ALICE}, 1, 100, 100, 0, 10, 10, 99, 'partial')
    `,
    (err: unknown) => String(err).includes('fee_settlements_collected_within_attempted'),
  )
})

test('a settlement marked charged must name the entry that charged it', { skip }, async () => {
  const botId = await aBot()
  await assert.rejects(
    () => sql`
      insert into fee_settlements (bot_id, user_id, period, equity, high_water_mark, gain, fee, attempted, collected, status)
      values (${botId}, ${ALICE}, 1, 100, 100, 0, 10, 10, 10, 'charged')
    `,
    (err: unknown) => String(err).includes('fee_settlements_charged_has_entry'),
  )
})

test('a settled LIVE fill must name the entry that settled it', { skip }, async () => {
  const botId = await aBot()
  await assert.rejects(
    () => sql`
      insert into fills (bot_id, user_id, bar_t, side, mode, price_scaled, qty, shards, fee_shards, reason, status)
      values (${botId}, ${ALICE}, 1, 'buy', 'live', 1, 1, 1, 0, 'x', 'settled')
    `,
    (err: unknown) => String(err).includes('fills_settled_has_entry'),
  )
})

test('a settled PAPER fill needs no entry, because a simulation never reaches the journal', { skip }, async () => {
  const botId = await aBot()
  await assert.doesNotReject(
    () => sql`
      insert into fills (bot_id, user_id, bar_t, side, mode, price_scaled, qty, shards, fee_shards, reason, status)
      values (${botId}, ${ALICE}, 2, 'buy', 'paper', 1, 1, 1, 0, 'x', 'settled')
    `,
  )
})

test('a running live bot without a capital reservation is refused by the schema', { skip }, async () => {
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  await assert.rejects(
    () => sql`
      insert into bots (user_id, name, mode, status, series_id, strategy_id, allocation, fee_bps)
      values (${ALICE}, 'live one', 'live', 'running', ${seriesId}, 'buy_hold', 1000, 1500)
    `,
    (err: unknown) => String(err).includes('bots_live_capital_reserved'),
  )
})

test('a paper bot needs no reservation, because no real capital is committed', { skip }, async () => {
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  await assert.doesNotReject(
    () => sql`
      insert into bots (user_id, name, mode, status, series_id, strategy_id, allocation, fee_bps)
      values (${ALICE}, 'paper one', 'paper', 'running', ${seriesId}, 'buy_hold', 1000, 1500)
    `,
  )
})

test('a bot cannot claim a price source outside the four this service knows', { skip }, async () => {
  // The vocabulary is enforced in the schema because a mark's provenance is read by screens and by
  // people, and a word nothing branches on renders as nothing. micro-org#368.
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  await assert.rejects(
    () => sql`
      insert into bots (user_id, name, mode, series_id, strategy_id, allocation, fee_bps, equity_price_source)
      values (${ALICE}, 'n', 'paper', ${seriesId}, 'buy_hold', 1000, 1500, 'oracle')
    `,
    (err: unknown) => String(err).includes('bots_equity_price_source_known'),
  )
  await assert.doesNotReject(
    () => sql`
      insert into bots (user_id, name, mode, series_id, strategy_id, allocation, fee_bps, equity_price_source)
      values (${ALICE}, 'n', 'paper', ${seriesId}, 'buy_hold', 1000, 1500, 'administered')
    `,
  )
})

test('a bot cannot hold a negative balance of anything', { skip }, async () => {
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  await assert.rejects(
    () => sql`
      insert into bots (user_id, name, mode, series_id, strategy_id, allocation, cash, fee_bps)
      values (${ALICE}, 'n', 'paper', ${seriesId}, 'buy_hold', 1000, -1, 1500)
    `,
    (err: unknown) => String(err).includes('bots_amounts_non_negative'),
  )
})

test('a bar whose open lies outside its own high-low range is refused by the schema', { skip }, async () => {
  const seriesId = await seedSeries(db, [])
  await assert.rejects(
    () => sql`insert into bars (series_id, t, o, h, l, c) values (${seriesId}, 3600, 500, 200, 100, 150)`,
    (err: unknown) => String(err).includes('bars_range_sane'),
  )
})

test('a bar at a non-positive price is refused, because nothing can be valued at zero', { skip }, async () => {
  const seriesId = await seedSeries(db, [])
  await assert.rejects(
    () => sql`insert into bars (series_id, t, o, h, l, c) values (${seriesId}, 3600, 0, 0, 0, 0)`,
    (err: unknown) => String(err).includes('bars_prices_positive'),
  )
})

test('a series is unique per symbol and timeframe, so two cannot disagree about one market', { skip }, async () => {
  await sql`insert into series (symbol, asset_code, timeframe, source) values ('ETH-USD', 'ETH', '1h', 'a')`
  await assert.rejects(
    () => sql`insert into series (symbol, asset_code, timeframe, source) values ('ETH-USD', 'ETH', '1h', 'b')`,
    (err: unknown) => String(err).includes('series_symbol_timeframe_uniq'),
  )
})

test('an unknown timeframe is refused, so a series cannot describe a bar width nothing produces', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into series (symbol, asset_code, timeframe, source) values ('X-USD', 'BTC', '3m', 'a')`,
    (err: unknown) => String(err).includes('series_timeframe_known'),
  )
})

test('a complete backtest must carry both a result and its digest', { skip }, async () => {
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  await assert.rejects(
    () => sql`
      insert into backtests (user_id, series_id, strategy_id, seed, start_cash, fee_bps, slippage_bps, status)
      values (${ALICE}, ${seriesId}, 'buy_hold', 0, 1000, 10, 5, 'complete')
    `,
    (err: unknown) => String(err).includes('backtests_terminal_has_outcome'),
  )
})

test('a failed backtest must say why it failed', { skip }, async () => {
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  await assert.rejects(
    () => sql`
      insert into backtests (user_id, series_id, strategy_id, seed, start_cash, fee_bps, slippage_bps, status)
      values (${ALICE}, ${seriesId}, 'buy_hold', 0, 1000, 10, 5, 'failed')
    `,
    (err: unknown) => String(err).includes('backtests_failed_has_error'),
  )
})

test('deleting a bot takes its fills and settlements with it, so no orphan money rows survive', { skip }, async () => {
  const botId = await aBot()
  await insertFill(botId, 1_700_000_400, 'buy')
  await insertSettlement(botId, 1n)
  await sql`delete from bots where id = ${botId}`
  const fills = await sql<{ n: number }[]>`select count(*)::int as n from fills`
  const settlements = await sql<{ n: number }[]>`select count(*)::int as n from fee_settlements`
  assert.equal(fills[0]?.n, 0)
  assert.equal(settlements[0]?.n, 0)
})

test('money columns are numeric, never bigint or double, so nothing is read back as a float', { skip }, async () => {
  // Named as explicit (table, column) pairs rather than by column name alone: `backtests.equity` is
  // the stored equity CURVE and is correctly jsonb, and a check that matched on the name would
  // either fail on it or be loosened until it proved nothing.
  const money: ReadonlyArray<readonly [string, string]> = [
    ['bots', 'allocation'], ['bots', 'cash'], ['bots', 'position'], ['bots', 'equity'],
    ['bots', 'high_water_mark'], ['bots', 'fee_owed'], ['bots', 'fee_paid'],
    ['backtests', 'start_cash'],
    ['fills', 'price_scaled'], ['fills', 'qty'], ['fills', 'shards'], ['fills', 'fee_shards'],
    ['fee_settlements', 'equity'], ['fee_settlements', 'high_water_mark'], ['fee_settlements', 'gain'],
    ['fee_settlements', 'fee'], ['fee_settlements', 'attempted'], ['fee_settlements', 'collected'],
    ['bars', 'o'], ['bars', 'h'], ['bars', 'l'], ['bars', 'c'], ['bars', 'v'],
  ]
  const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'
  `
  const byKey = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]))
  for (const [table, column] of money) {
    assert.equal(byKey.get(`${table}.${column}`), 'numeric', `${table}.${column} is not numeric`)
  }
})

/* ------------------------------------------------------------------ helpers */

async function aBot(): Promise<string> {
  const seriesId = await seedSeries(db, makeBars({ count: 3 }))
  const rows = await sql<{ id: string }[]>`
    insert into bots (user_id, name, mode, series_id, strategy_id, allocation, fee_bps)
    values (${ALICE}, 'a bot', 'paper', ${seriesId}, 'buy_hold', 1000, 1500)
    returning id
  `
  const id = rows[0]?.id
  if (!id) throw new Error('no bot')
  return id
}

async function insertSettlement(botId: string, period: bigint): Promise<void> {
  await sql`
    insert into fee_settlements (bot_id, user_id, period, equity, high_water_mark, gain, fee, attempted, collected, status)
    values (${botId}, ${ALICE}, ${period.toString()}, 100, 100, 0, 10, 10, 0, 'pending')
  `
}

async function insertFill(botId: string, barT: number, side: string): Promise<void> {
  await sql`
    insert into fills (bot_id, user_id, bar_t, side, mode, price_scaled, qty, shards, fee_shards, reason)
    values (${botId}, ${ALICE}, ${barT}, ${side}, 'paper', 1000000, 1, 1, 0, 'x')
  `
}
