/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about what
 * "version 6" means. The fix for a wrong migration is always a new migration.
 *
 * ## What this schema fixes about the service it supersedes
 *
 * Three of the tables below carry a constraint that exists because the frozen Crucible schema does
 * not have it, and each of those omissions cost money:
 *
 *   1. `fee_settlements_bot_period_uniq`. The frozen `insertSettlement` mints `id: randomUUID()`
 *      (`crucible/services/crucible/src/store.ts:452`) and `fee_settlements` has no unique
 *      constraint at all (`crucible/services/crucible/src/db/migrate.ts:199-207` creates three
 *      plain indexes and no unique one). Because the Pay idempotency key is derived from the row id
 *      — `crucible:settlement:<rowId>`, `clients/pay.ts:134` — two attempts at the same settlement
 *      produce two DIFFERENT keys and the upstream correctly honours both. Making `(bot_id, period)`
 *      unique means the second attempt cannot get a row, so it cannot get a second key. 14 §5 names
 *      this as a mandatory concurrency test and 04 §10.5 names the lease key `bot_id:period`.
 *   2. `fills_bot_bar_side_uniq`. This one the frozen service DOES have
 *      (`crucible/services/crucible/src/db/migrate.ts:159`) and it is the single best line in that
 *      repository — it is carried forward unchanged, because the gap between deciding to fill and
 *      having filled is exactly where a crash costs somebody money.
 *   3. Money is `numeric(78,0)`, never `bigint(mode:'number')`. The frozen schema declares every
 *      Shard column as `bigint` and then reads it into a JavaScript **number**
 *      (`crucible/services/crucible/src/db/schema.ts:66-75`, `{ mode: 'number' }`), so every
 *      balance in that service is a float wearing an integer's name. 04 §0: no floats anywhere in
 *      money.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of the
      -- backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the event
      -- to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'idempotency',
    up: `
      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        -- sha256 of the canonicalised request body. A reused key with a changed payload is a caller
        -- bug that must be reported, not absorbed.
        request_hash text        not null,
        -- Null while the claiming transaction is still running. A duplicate that finds null is told
        -- to retry rather than handed an answer that does not exist yet.
        response     jsonb,
        -- What the claim produced, so an operator can join a key to the bot, fill or settlement it
        -- created. Deliberately a free text urn rather than a foreign key: the claim outlives some
        -- of the rows it points at, and a cascade would delete the evidence.
        subject_urn  text,
        created_at   timestamptz not null default now()
      );

      -- The reaper's access path.
      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },
  {
    version: 5,
    name: 'series',
    up: `
      -- A named, immutable candle series. A backtest names one, and that is what makes "same
      -- strategy, same input series, same seed" a checkable claim rather than a hope: the series is
      -- identified, its bars are append-only, and a run records the id it read.
      create table if not exists series (
        id          uuid        primary key default gen_random_uuid(),
        symbol      text        not null,
        asset_code  text        not null,
        timeframe   text        not null,
        source      text        not null,
        created_at  timestamptz not null default now(),
        constraint series_timeframe_known check (timeframe in ('5m','15m','1h','4h','1d')),
        constraint series_symbol_timeframe_uniq unique (symbol, timeframe)
      );

      -- OHLCV, in scaled integers. Every price is USD per whole unit scaled by RATE_SCALE (10^6),
      -- stored as numeric(78,0). 04 §0 forbids a float anywhere in money, and a candle close is the
      -- number every fill price is derived from — it is money by another name.
      --
      -- Only CLOSED bars are ever written. Feeding the in-progress bar to an indicator is the
      -- classic backtest lie: it lets a strategy see a close that has not happened yet, and turns a
      -- losing rule into a winning one. The frozen feed drops the last bar for exactly this reason
      -- (crucible/services/crucible/src/market/feed.ts:37-40); here the ingest route refuses it.
      create table if not exists bars (
        series_id  uuid          not null references series (id) on delete cascade,
        -- Bar OPEN time, unix seconds.
        t          bigint        not null,
        o          numeric(78,0) not null,
        h          numeric(78,0) not null,
        l          numeric(78,0) not null,
        c          numeric(78,0) not null,
        v          numeric(78,0) not null default 0,
        primary key (series_id, t),
        constraint bars_prices_positive check (o > 0 and h > 0 and l > 0 and c > 0),
        -- A bar whose high is below its low, or whose open sits outside its own range, is not a bar.
        -- Refusing it here rather than in the ingest handler is what stops a bad feed from making
        -- every backtest run against it quietly wrong.
        constraint bars_range_sane check (h >= l and o between l and h and c between l and h)
      );
    `,
  },
  {
    version: 6,
    name: 'backtests',
    up: `
      -- A backtest is a JOB, not a request.
      --
      -- The frozen service runs the whole thing inside the POST
      -- (crucible/services/crucible/src/routes/backtests.ts:30-128, and its own comment at :26-29
      -- argues the case). That is defensible at a thousand candles and indefensible at the drain:
      -- the ten-second shutdown kills the request and the run is lost with it. Here the route
      -- writes 'queued' and answers 202 with a status url, and 'bot.backtest' does the work under a
      -- lease.
      create table if not exists backtests (
        id             uuid          primary key default gen_random_uuid(),
        user_id        uuid          not null,
        status         text          not null default 'queued',
        series_id      uuid          not null references series (id),
        strategy_id    text          not null,
        params         jsonb         not null default '{}'::jsonb,
        -- The seed is part of the identity of a run. Same strategy + same series + same seed must
        -- give byte-identical results, and a run that does not record its seed cannot be reproduced.
        seed           bigint        not null,
        start_cash     numeric(78,0) not null,
        fee_bps        integer       not null,
        slippage_bps   integer       not null,
        from_t         bigint,
        to_t           bigint,
        -- sha256 over the canonicalised result. This is the determinism claim, written down: two
        -- runs of the same input must produce the same digest, and a test asserts it.
        result_digest  text,
        metrics        jsonb,
        trades         jsonb,
        equity         jsonb,
        notes          jsonb         not null default '[]'::jsonb,
        error          text,
        created_at     timestamptz   not null default now(),
        completed_at   timestamptz,
        constraint backtests_status_known check (status in ('queued','running','complete','failed')),
        constraint backtests_start_cash_positive check (start_cash > 0),
        constraint backtests_costs_sane check (fee_bps between 0 and 500 and slippage_bps between 0 and 500),
        constraint backtests_seed_non_negative check (seed >= 0),
        -- A terminal run has an answer of one kind or the other. Without this a 'complete' row with
        -- neither metrics nor an error reads as a successful run of nothing.
        constraint backtests_terminal_has_outcome check (
          status <> 'complete' or (metrics is not null and result_digest is not null)
        ),
        constraint backtests_failed_has_error check (status <> 'failed' or error is not null)
      );

      create index if not exists backtests_user_idx on backtests (user_id, created_at desc);
    `,
  },
  {
    version: 7,
    name: 'bots',
    up: `
      -- A bot. Cash and position are this service's record of INTENT and of what it observed the
      -- ledger do — they are not a balance, and nothing here is authoritative about money.
      -- 04 §11: "no 'user balance' column anywhere outside the ledger's projection … A cached
      -- balance in a product database is the bug that made Crucible's bot state diverge from Pay's."
      --
      -- The distinction is kept honest by two things: a paper bot's cash is imaginary and never
      -- touches the ledger at all, and a live bot's cash is only ever moved by applying a fill whose
      -- ledger entry id is recorded on the fill row.
      create table if not exists bots (
        id             uuid          primary key default gen_random_uuid(),
        user_id        uuid          not null,
        name           text          not null,
        mode           text          not null,
        status         text          not null default 'draft',
        series_id      uuid          not null references series (id),
        strategy_id    text          not null,
        params         jsonb         not null default '{}'::jsonb,
        -- Capital committed at start, in Shards. For a live bot this is held as a ledger
        -- RESERVATION and reservation_entry_id is the id the ledger gave back. 07 §6: "market,
        -- trade hold the reservation *id* only".
        allocation     numeric(78,0) not null,
        reservation_entry_id uuid,
        cash           numeric(78,0) not null default 0,
        -- Base-asset holding in smallest units. An integer, so it is exact; the frozen service
        -- stores this as a decimal STRING parsed with Number()
        -- (crucible/packages/contracts/src/index.ts:648-655), which is a float in a text column.
        position       numeric(78,0) not null default 0,
        equity         numeric(78,0) not null default 0,
        -- Highest equity ever SETTLED against. The performance fee is charged only on gains above
        -- this line. It must never move down — see the invariants in src/fees.ts.
        high_water_mark numeric(78,0) not null default 0,
        fee_bps        integer       not null,
        fee_owed       numeric(78,0) not null default 0,
        fee_paid       numeric(78,0) not null default 0,
        -- Opaque per-strategy accumulators (grid anchor, trailing stop, DCA counter). Carried
        -- forward from the frozen runner, whose comment at
        -- crucible/services/crucible/src/engine/strategies.ts:26-47 is the reason it exists.
        state          jsonb         not null default '{}'::jsonb,
        -- Open time of the last bar acted on, so a restart cannot replay a bar.
        last_bar_t     bigint,
        last_error     text,
        last_tick_at   timestamptz,
        started_at     timestamptz,
        stopped_at     timestamptz,
        created_at     timestamptz   not null default now(),
        constraint bots_mode_known check (mode in ('paper','live')),
        constraint bots_status_known check (status in ('draft','running','paused','stopped','errored')),
        constraint bots_allocation_positive check (allocation > 0),
        constraint bots_amounts_non_negative check (
          cash >= 0 and position >= 0 and equity >= 0 and high_water_mark >= 0
            and fee_owed >= 0 and fee_paid >= 0
        ),
        constraint bots_fee_bps_sane check (fee_bps between 0 and 5000),
        -- A RUNNING live bot's capital is a ledger reservation or it is nothing. Enforcing it here
        -- means a code path that forgets to reserve cannot start a bot instead of failing quietly.
        --
        -- Scoped to running rather than to "not draft", which is how it was first written: stopping
        -- a bot RELEASES the reservation, so the wider version made that release violate the
        -- constraint, the update was rolled back, and a stopped bot held its user's capital out of
        -- reach for ever. Caught by src/fees.test.ts.
        constraint bots_live_capital_reserved check (
          mode <> 'live' or status <> 'running' or reservation_entry_id is not null
        )
      );

      create index if not exists bots_user_idx on bots (user_id, created_at desc);
      -- The tick producer's access path. Partial, because the running set is a small slice of the
      -- table and the sweep reads it once a tick.
      create index if not exists bots_running_idx on bots (id) where status = 'running';
      -- The settlement sweep's second list: bots that have LEFT the running set still owing
      -- something. Sweeping only the running ones is what left the frozen service's stopped bots
      -- carrying an undecided row for ever (crucible/services/crucible/src/runner.ts:441-449).
      create index if not exists bots_arrears_idx on bots (id) where fee_owed > 0;
    `,
  },
  {
    version: 8,
    name: 'fills',
    up: `
      -- A fill is money.
      --
      -- The row is written BEFORE anything moves, and the unique index below is what makes the
      -- runner safe to restart mid-tick: a duplicate evaluation of the same bar collides here
      -- rather than at the ledger. Carried forward verbatim in intent from
      -- crucible/services/crucible/src/db/migrate.ts:159 — the frozen service got this right and it
      -- is the reason its live path has never double-traded a bar.
      create table if not exists fills (
        id             uuid          primary key default gen_random_uuid(),
        bot_id         uuid          not null references bots (id) on delete cascade,
        user_id        uuid          not null,
        -- Open time of the bar this fill was decided on.
        bar_t          bigint        not null,
        side           text          not null,
        -- Copied from the bot, deliberately, and immutable once written.
        --
        -- Denormalised because it is what decides whether this row is REQUIRED to name a ledger
        -- entry: a live fill that settled without one makes "did my retry post twice" unanswerable,
        -- and a paper fill will never have one because posting a simulation to the journal is the
        -- thing that must not happen. Joining to the bots table to find that out would put the check in
        -- application code, where it is a convention rather than a guarantee.
        mode           text          not null,
        -- USD per whole unit at RATE_SCALE, as it actually settled.
        price_scaled   numeric(78,0) not null,
        -- Base-asset smallest units moved.
        qty            numeric(78,0) not null default 0,
        -- Shards moved, signed: negative on a buy, positive on a sell.
        shards         numeric(78,0) not null default 0,
        fee_shards     numeric(78,0) not null default 0,
        reason         text          not null,
        status         text          not null default 'planned',
        -- The ledger entry this fill posted, once the ledger has told us it did. NULL while the
        -- outcome is unknown, which is a different fact from zero — see src/fills.ts.
        entry_id       uuid,
        error          text,
        created_at     timestamptz   not null default now(),
        settled_at     timestamptz,
        constraint fills_side_known check (side in ('buy','sell')),
        constraint fills_mode_known check (mode in ('paper','live')),
        constraint fills_status_known check (status in ('planned','settled','refused','unresolved')),
        constraint fills_amounts_sane check (qty >= 0 and fee_shards >= 0 and price_scaled > 0),
        -- A settled LIVE fill names the entry that settled it. This is the line that makes "did my
        -- retry post twice" answerable — and it is scoped to live because a paper fill has no entry
        -- by design. An unscoped version of this constraint makes every paper bot unable to fill at
        -- all, which is how it was first written and what src/fills.test.ts caught.
        constraint fills_settled_has_entry check (
          status <> 'settled' or mode = 'paper' or entry_id is not null
        ),
        -- One fill per (bot, bar, side), for ever.
        constraint fills_bot_bar_side_uniq unique (bot_id, bar_t, side)
      );

      create index if not exists fills_bot_idx on fills (bot_id, created_at desc);
      create index if not exists fills_user_idx on fills (user_id, created_at desc);
    `,
  },
  {
    version: 9,
    name: 'fee_settlements',
    up: `
      -- The performance fee, one row per bot per period.
      --
      -- **fee_settlements_bot_period_uniq is the whole point of this table.** The frozen service
      -- has no unique constraint here and derives its upstream idempotency key from a random row id
      -- (crucible/services/crucible/src/store.ts:452), so two passes over one settlement bill twice
      -- under two keys that the upstream cannot recognise as the same request. Making the row's
      -- identity (bot_id, period) makes the second pass lose the insert, which is what makes the
      -- SECOND KEY IMPOSSIBLE rather than merely unlikely.
      --
      -- period is floor(epoch_seconds / TRADE_SETTLEMENT_PERIOD_SECONDS) -- see src/fees.ts.
      create table if not exists fee_settlements (
        id              uuid          primary key default gen_random_uuid(),
        bot_id          uuid          not null references bots (id) on delete cascade,
        user_id         uuid          not null,
        period          bigint        not null,
        equity          numeric(78,0) not null,
        high_water_mark numeric(78,0) not null,
        gain            numeric(78,0) not null,
        fee             numeric(78,0) not null,
        -- What this row was actually SENT for, after any lowering to what the balance could cover.
        -- Written before the request goes out, so a retry re-sends the identical amount. The frozen
        -- service added this column for exactly this reason and says so at
        -- crucible/services/crucible/src/db/migrate.ts:176-178.
        attempted       numeric(78,0) not null,
        collected       numeric(78,0) not null default 0,
        status          text          not null default 'pending',
        entry_id        uuid,
        last_error      text,
        created_at      timestamptz   not null default now(),
        resolved_at     timestamptz,
        constraint fee_settlements_status_known check (
          status in ('pending','charged','partial','uncollectable')
        ),
        constraint fee_settlements_amounts_non_negative check (
          equity >= 0 and high_water_mark >= 0 and gain >= 0 and fee >= 0
            and attempted >= 0 and collected >= 0
        ),
        constraint fee_settlements_collected_within_attempted check (collected <= attempted),
        constraint fee_settlements_charged_has_entry check (status <> 'charged' or entry_id is not null),
        constraint fee_settlements_period_non_negative check (period >= 0),
        constraint fee_settlements_bot_period_uniq unique (bot_id, period)
      );

      create index if not exists fee_settlements_bot_idx on fee_settlements (bot_id, created_at desc);
      create index if not exists fee_settlements_user_idx on fee_settlements (user_id, created_at desc);
      -- The pending set, which invariant 4 in src/fees.ts is enforced from. Partial, because a
      -- pending row is by design a rare and transient thing.
      create index if not exists fee_settlements_pending_idx
        on fee_settlements (bot_id)
        where status = 'pending';
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the old
 * schema when a deploy runs ahead of its migrator.
 *
 * Here that is more than hygiene: below version 9 the `(bot_id, period)` unique constraint does not
 * exist, and a replica running this code against version 8 would double-bill exactly the way the
 * service it supersedes does.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted.
 *
 * A new service leaves this at 0, and this is a new service. The frozen Crucible schema is NOT
 * baselined against: it has no `schema_migrations` table, its money columns are the wrong type, and
 * the constraint this repository exists to add is precisely the one it lacks. Migration is a data
 * copy, not a baseline.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'fee_settlements',
  'fills',
  'bots',
  'backtests',
  'bars',
  'series',
  'idempotency_keys',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
