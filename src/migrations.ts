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
  {
    version: 10,
    name: 'exchange',
    // ────────────────────────────────────────────────────────────────────────────────────────────
    // THE ORDER BOOK.
    //
    // Everything above this line is one customer trading against a price feed. Everything below it
    // is customers trading against EACH OTHER, which is a different kind of system with a different
    // set of ways to lose money, and the schema is where most of those are closed:
    //
    //   * `orders.sequence` is a `bigserial`, not a timestamp. Two orders accepted in the same
    //     millisecond are routine and `now()` cannot rank them; `nextval` can. src/exchange.ts
    //     draws it inside the market row's lock, so lock order is arrival order is match order.
    //   * `trades_not_self` is self-trade prevention AS A DATABASE CONSTRAINT. The engine prevents
    //     it and src/matching.test.ts proves the engine does, but a wash trade printed to a public
    //     tape is the kind of defect that is discovered by a regulator, so it is also made
    //     impossible to store.
    //   * `exchange_accounts` splits every balance into `available` and `held`, both `>= 0`. An
    //     open order's escrow lives in `held`, which is what makes "spend the same coin twice" a
    //     constraint violation rather than a race you have to win.
    //   * Every amount is `numeric(78,0)`. There is no float in this schema and there is no column
    //     that could hold one.
    //
    // The exactness rule, `markets_notional_exact`, is the one worth reading twice. A fill's
    // notional is `qty * price / 10^base_decimals`, and if that division is ever inexact the
    // remainder is money that arrived nowhere. Because every quantity is a multiple of `lot_size`
    // and every price a multiple of `tick_size`, requiring `(lot_size * tick_size)` to be a
    // multiple of `10^base_decimals` makes every possible fill in the market exact. It is checked
    // here rather than in application code because a market created by hand in psql would otherwise
    // start losing fractions and nothing would say so.
    // ────────────────────────────────────────────────────────────────────────────────────────────
    up: `
      create table if not exists markets (
        id               uuid          primary key default gen_random_uuid(),
        symbol           text          not null,
        base_asset       text          not null,
        quote_asset      text          not null,
        base_decimals    integer       not null,
        quote_decimals   integer       not null,
        lot_size         numeric(78,0) not null,
        tick_size        numeric(78,0) not null,
        min_notional     numeric(78,0) not null,
        maker_fee_bps    integer       not null default 10,
        taker_fee_bps    integer       not null default 20,
        -- active: everything. post_only: no taking, so a wide book can be rebuilt without anyone
        -- being run over. cancel_only: no new orders, existing ones may be pulled. halted: nothing.
        status           text          not null default 'active',
        -- The price band, as basis points either side of reference_price. A market order's
        -- protection price is derived from it, and a limit outside it is refused. This is the
        -- fat-finger control; see src/exchange.ts.
        band_bps         integer       not null default 2000,
        reference_price  numeric(78,0),
        last_price       numeric(78,0),
        last_traded_at   timestamptz,
        created_at       timestamptz   not null default now(),
        updated_at       timestamptz   not null default now(),
        constraint markets_symbol_uniq unique (symbol),
        constraint markets_assets_differ check (base_asset <> quote_asset),
        constraint markets_status_known check (status in ('active','post_only','cancel_only','halted')),
        constraint markets_decimals_sane check (
          base_decimals between 0 and 30 and quote_decimals between 0 and 30
        ),
        constraint markets_sizes_positive check (
          lot_size > 0 and tick_size > 0 and min_notional >= 0
        ),
        constraint markets_fees_sane check (
          maker_fee_bps between 0 and 1000 and taker_fee_bps between 0 and 1000
        ),
        constraint markets_band_sane check (band_bps between 1 and 10000),
        constraint markets_prices_positive check (
          (reference_price is null or reference_price > 0) and (last_price is null or last_price > 0)
        ),
        constraint markets_notional_exact check (
          mod(lot_size * tick_size, power(10::numeric, base_decimals)) = 0
        )
      );

      -- The custodial sub-ledger. One row per (customer, asset); the platform's fee income sits in
      -- the same table under the all-zero user id, so that "does the exchange conserve value" is
      -- one SUM over one table and not a reconciliation between two.
      create table if not exists exchange_accounts (
        user_id    uuid          not null,
        asset      text          not null,
        available  numeric(78,0) not null default 0,
        held       numeric(78,0) not null default 0,
        updated_at timestamptz   not null default now(),
        primary key (user_id, asset),
        constraint exchange_accounts_non_negative check (available >= 0 and held >= 0)
      );

      -- Money crossing the boundary between the customer's ledger balance and the exchange's
      -- custody. These are the ONLY two operations that touch the ledger; a match moves nothing
      -- outside this schema, which is what lets a match be a single local transaction.
      create table if not exists exchange_transfers (
        id         uuid          primary key default gen_random_uuid(),
        user_id    uuid          not null,
        asset      text          not null,
        direction  text          not null,
        amount     numeric(78,0) not null,
        status     text          not null default 'pending',
        entry_id   uuid,
        error      text,
        created_at timestamptz   not null default now(),
        settled_at timestamptz,
        constraint exchange_transfers_direction_known check (direction in ('deposit','withdrawal')),
        constraint exchange_transfers_status_known check (
          status in ('pending','settled','refused','unresolved')
        ),
        constraint exchange_transfers_amount_positive check (amount > 0),
        constraint exchange_transfers_settled_has_entry check (status <> 'settled' or entry_id is not null)
      );

      create index if not exists exchange_transfers_user_idx
        on exchange_transfers (user_id, created_at desc);
      create index if not exists exchange_transfers_open_idx
        on exchange_transfers (created_at)
        where status in ('pending','unresolved');

      create table if not exists orders (
        id               uuid          primary key default gen_random_uuid(),
        market_id        uuid          not null references markets (id) on delete restrict,
        user_id          uuid          not null,
        -- Arrival rank. See the header: this is price-TIME priority's time.
        sequence         bigserial     not null,
        -- The customer's own label, echoed back so they can reconcile without storing our ids.
        client_order_id  text,
        side             text          not null,
        type             text          not null,
        price            numeric(78,0),
        stop_price       numeric(78,0),
        tif              text          not null default 'gtc',
        post_only        boolean       not null default false,
        stp              text          not null default 'cancel_taker',
        qty              numeric(78,0),
        quote_qty        numeric(78,0),
        -- A reserve order: only this much is published in the depth feed. The hidden remainder is
        -- real liquidity and matches normally and does NOT lose its place in the queue, which is
        -- what distinguishes it from a slice-refreshing iceberg. Said plainly in src/exchange.ts.
        display_qty      numeric(78,0),
        remaining        numeric(78,0) not null default 0,
        filled_qty       numeric(78,0) not null default 0,
        filled_quote_qty numeric(78,0) not null default 0,
        fee_base         numeric(78,0) not null default 0,
        fee_quote        numeric(78,0) not null default 0,
        held_asset       text,
        held_amount      numeric(78,0) not null default 0,
        status           text          not null default 'open',
        cancel_reason    text,
        expires_at       timestamptz,
        created_at       timestamptz   not null default now(),
        updated_at       timestamptz   not null default now(),
        constraint orders_side_known check (side in ('buy','sell')),
        constraint orders_type_known check (type in ('limit','market','stop_limit','stop_market')),
        constraint orders_tif_known check (tif in ('gtc','ioc','fok','gtd')),
        constraint orders_stp_known check (
          stp in ('cancel_taker','cancel_maker','cancel_both','decrement_and_cancel')
        ),
        constraint orders_status_known check (
          status in ('pending_trigger','open','filled','cancelled','rejected','expired')
        ),
        constraint orders_amounts_non_negative check (
          remaining >= 0 and filled_qty >= 0 and filled_quote_qty >= 0
            and fee_base >= 0 and fee_quote >= 0 and held_amount >= 0
            and (qty is null or qty > 0) and (quote_qty is null or quote_qty > 0)
            and (display_qty is null or display_qty > 0)
        ),
        constraint orders_prices_positive check (
          (price is null or price > 0) and (stop_price is null or stop_price > 0)
        ),
        -- A limit order without a price is not an order, and a market order with one is a limit
        -- order that lied about its type.
        constraint orders_limit_has_price check (
          (type in ('limit','stop_limit')) = (price is not null)
        ),
        constraint orders_stop_has_trigger check (
          (type in ('stop_limit','stop_market')) = (stop_price is not null)
        ),
        -- Exactly one of the two ways to size an order. A quote-driven order is a market buy and
        -- nothing else; see the note on matchOrder in src/matching.ts about why a market buy sized
        -- in base units cannot be escrowed honestly.
        constraint orders_one_size check ((qty is null) <> (quote_qty is null)),
        constraint orders_quote_only_market_buy check (
          quote_qty is null or (side = 'buy' and type in ('market','stop_market'))
        ),
        constraint orders_gtd_has_expiry check ((tif = 'gtd') = (expires_at is not null)),
        constraint orders_held_has_asset check (held_amount = 0 or held_asset is not null),
        -- Nothing may still be reserved once an order has stopped being live. This is the
        -- constraint that turns "we forgot to release the escrow" from a support ticket about a
        -- missing balance into a failed transaction.
        constraint orders_terminal_holds_nothing check (
          status in ('pending_trigger','open') or held_amount = 0
        )
      );

      -- THE BOOK READ. Partial on the live statuses, and ordered exactly as bookOrder in
      -- src/matching.ts ranks: price then sequence. A plain index here would still answer, but
      -- would make the hot path scan every terminal order the market has ever had.
      create index if not exists orders_book_idx
        on orders (market_id, side, price, sequence)
        where status = 'open';
      create index if not exists orders_user_idx on orders (user_id, created_at desc);
      create index if not exists orders_user_open_idx
        on orders (user_id, market_id)
        where status in ('open','pending_trigger');
      create index if not exists orders_trigger_idx
        on orders (market_id, stop_price)
        where status = 'pending_trigger';
      create index if not exists orders_expiry_idx
        on orders (expires_at)
        where status = 'open' and expires_at is not null;
      -- A client order id identifies ONE live order. Reusing it after that order is done is
      -- allowed, which is why the index is partial: otherwise a customer's own numbering scheme
      -- would run out.
      create unique index if not exists orders_client_id_uniq
        on orders (user_id, market_id, client_order_id)
        where client_order_id is not null and status in ('open','pending_trigger');

      create table if not exists trades (
        id              uuid          primary key default gen_random_uuid(),
        seq             bigserial     not null,
        market_id       uuid          not null references markets (id) on delete restrict,
        taker_order_id  uuid          not null references orders (id) on delete restrict,
        maker_order_id  uuid          not null references orders (id) on delete restrict,
        taker_user_id   uuid          not null,
        maker_user_id   uuid          not null,
        taker_side      text          not null,
        price           numeric(78,0) not null,
        qty             numeric(78,0) not null,
        quote_qty       numeric(78,0) not null,
        taker_fee       numeric(78,0) not null default 0,
        maker_fee       numeric(78,0) not null default 0,
        taker_fee_asset text          not null,
        maker_fee_asset text          not null,
        created_at      timestamptz   not null default now(),
        constraint trades_side_known check (taker_side in ('buy','sell')),
        constraint trades_fee_assets_known check (
          taker_fee_asset in ('base','quote') and maker_fee_asset in ('base','quote')
        ),
        constraint trades_amounts_positive check (
          price > 0 and qty > 0 and quote_qty > 0 and taker_fee >= 0 and maker_fee >= 0
        ),
        constraint trades_orders_differ check (taker_order_id <> maker_order_id),
        -- Self-trade prevention, in the database. A tape that carries an account trading with
        -- itself is a false volume figure, and a false volume figure is the thing a market
        -- surveillance review looks for first.
        constraint trades_not_self check (taker_user_id <> maker_user_id)
      );

      create index if not exists trades_market_idx on trades (market_id, seq desc);
      create index if not exists trades_taker_idx on trades (taker_user_id, created_at desc);
      create index if not exists trades_maker_idx on trades (maker_user_id, created_at desc);

      -- The lifecycle, appended to and never rewritten. orders.status is where an order IS;
      -- this is how it got there, which is the question a customer disputing a fill actually asks.
      create table if not exists order_events (
        id         uuid          primary key default gen_random_uuid(),
        order_id   uuid          not null references orders (id) on delete cascade,
        seq        bigserial     not null,
        kind       text          not null,
        qty        numeric(78,0) not null default 0,
        price      numeric(78,0),
        detail     text,
        created_at timestamptz   not null default now(),
        constraint order_events_kind_known check (
          kind in ('accepted','triggered','filled','cancelled','rejected','expired','reduced')
        )
      );

      create index if not exists order_events_order_idx on order_events (order_id, seq);

      -- Rate limiting as a fixed window in the database rather than a counter in a process.
      -- Two replicas sharing one limit is the requirement; a per-process counter silently doubles
      -- every limit the moment the service scales, which is exactly when the limit matters.
      create table if not exists rate_limits (
        bucket       text        not null,
        window_start timestamptz not null,
        count        integer     not null default 0,
        primary key (bucket, window_start),
        constraint rate_limits_count_non_negative check (count >= 0)
      );

      create index if not exists rate_limits_window_idx on rate_limits (window_start);

      -- The markets this estate lists, seeded so that a fresh deploy has a usable exchange rather
      -- than an empty one waiting on a manual step. Reference data, not customer data: re-running
      -- the migrator changes nothing, and an operator who has retuned a market keeps their tuning.
      --
      -- Every pair quotes in EMBER because SHARD is retired (contracts-chain RETIRED_ASSETS) and
      -- EMBER is the estate's own issuable unit. Lot and tick are chosen so that
      -- (lot * tick) mod 10^base_decimals = 0 -- markets_notional_exact refuses anything else.
      insert into markets (symbol, base_asset, quote_asset, base_decimals, quote_decimals, lot_size, tick_size, min_notional)
      values
        ('BTC-EMBER',  'BTC',  'EMBER', 8,  18, 10000,               1000000000000, 10000000000000000),
        ('ETH-EMBER',  'ETH',  'EMBER', 18, 18, 1000000000000000,    1000000000000, 10000000000000000),
        ('LTC-EMBER',  'LTC',  'EMBER', 8,  18, 1000000,             1000000000000, 10000000000000000),
        ('DOGE-EMBER', 'DOGE', 'EMBER', 8,  18, 100000000,           10000000000,   10000000000000000),
        ('SOL-EMBER',  'SOL',  'EMBER', 9,  18, 10000000,            1000000000000, 10000000000000000),
        ('XRP-EMBER',  'XRP',  'EMBER', 6,  18, 1000000,             1000000000000, 10000000000000000),
        ('ETC-EMBER',  'ETC',  'EMBER', 18, 18, 10000000000000000,   1000000000000, 10000000000000000)
      on conflict (symbol) do nothing;
    `,
  },
  {
    version: 11,
    name: 'equity_price_source',
    // ────────────────────────────────────────────────────────────────────────────────────────────
    // WHERE THE MARK CAME FROM.
    //
    // `bots.equity` has been a mark-to-market number since version 6 and has never said what it was
    // marked AGAINST. That is the defect micro-org#368 names: on this estate the only series that
    // exists is EMBER-denominated, and pricing serves EMBER as `administered` — a price an operator
    // typed, which by pricing's own design never goes stale and is not a median of anything. A user
    // reading an equity curve cannot tell that apart from a coin with four independent sources
    // behind it, and neither can anything downstream, because the fact was never recorded.
    //
    // A column rather than a note on the screen, because the provenance belongs to the WRITE. The
    // tick that marks the position is the only moment the answer is known; recomputing it later
    // from the asset's CURRENT source would report today's arrangement against an equity figure
    // written weeks ago, and would be wrong in exactly the cases anyone would care about — an asset
    // that moved from administered to market, or the other way.
    //
    // Nullable, and null is a statement: no mark has happened yet. `insertBot` seeds `equity` from
    // `allocation`, so a draft bot's equity is the capital committed and not a valuation at all.
    // There is no backfill for the same reason there is no default — mainnet and testnet both hold
    // zero rows in this table (measured 2026-08-12 on both networks and recorded on micro-org#368),
    // and inventing a provenance for a row that has one would be the same lie in a new column.
    // ────────────────────────────────────────────────────────────────────────────────────────────
    up: `
      alter table bots add column if not exists equity_price_source text;

      -- The vocabulary, enforced here so a hand-written update cannot invent a fifth word:
      --   market       -- pricing quoted a median of independent sources
      --   administered -- pricing quoted a number an operator set (EMBER today)
      --   bar          -- a PAPER bot, marked at the series' own last closed bar; not a quote at all
      --   unknown      -- pricing answered with a word this build does not recognise
      -- 'bar' and 'unknown' are the two that make the column honest rather than merely present: a
      -- paper bot never calls pricing, and a source string off the wire must not be filed under
      -- 'market' because nothing matched.
      alter table bots drop constraint if exists bots_equity_price_source_known;
      alter table bots add constraint bots_equity_price_source_known check (
        equity_price_source is null
          or equity_price_source in ('market','administered','bar','unknown')
      );
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
  'rate_limits',
  'order_events',
  'trades',
  'orders',
  'exchange_transfers',
  'exchange_accounts',
  'markets',
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
