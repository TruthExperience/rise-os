-- ============================================================================
-- 2026-11-26  TRL: opening-balance grants for the four divisions whose ledgers
--             were restated without one.
--
-- What went wrong
-- ---------------
-- TRL's wallets were re-baselined in place (a manual_adjustment with
-- related_type = 'config_reset' per wallet) but the season_start_grant that
-- explains how the money arrived was never written, so 43 wallets had a ledger
-- whose first row was a debit. /cap reports what the ledger says, so it counted
-- the restatement as spending against a wallet that never showed an opening
-- balance.
--
-- This is the missing half of that history: a grant of the wallet's opening
-- balance, dated one minute before the restatement, with balance_after equal to
-- the grant (the state the wallet was in immediately after it). Balances are
-- not touched — grant and reset already net to today's balance, which is why
-- this is a ledger repair and not a payment.
--
-- Applied to the live database on 2026-11-26 as ad-hoc SQL (43 rows), and
-- recorded here so a rebuilt database reproduces the same ledger.
--
-- Idempotent: a wallet that already has a season_start_grant is left alone, so
-- re-running this against the live database inserts nothing.
--
-- Out of scope: F1_26 and T1. Their wallets were created through
-- /api/admin/wallets/initialize, which writes the grant itself; the four
-- divisions below were seeded with wallets but no ledger trail.
-- ============================================================================

insert into pitboss.wallet_transactions
  (wallet_id, franchise_id, league_id, season, transaction_type, amount,
   balance_after, description, created_at)
select w.id,
       w.franchise_id,
       w.league_id,
       w.season,
       'season_start_grant',
       g.opening_grant,
       g.opening_grant,
       'Season ' || w.season ||
         ' opening balance, backfilled 2026-11-26 (sits before the wallet restructure reset)',
       coalesce(f.first_at, now()) - interval '1 minute'
  from pitboss.franchise_wallets w
  join rise_os.leagues l
    on l.id = w.league_id
   and l.slug = 'trl'
  join (values
          ('F1',    150000000::numeric),
          ('F1_25', 150000000::numeric),
          ('F2_24',  40000000::numeric),
          ('F2_25',  40000000::numeric)
       ) as g(division, opening_grant)
    on g.division = w.division
  -- The grant sits immediately before whatever the wallet's ledger already
  -- starts with, which on the live database is the config_reset row itself
  -- (2026-11-08 19:24:32.699 → grants at 19:23:32.699, matching the 43 rows
  -- this reproduces). A wallet with no ledger at all starts one minute from now.
  left join lateral (
    select min(x.created_at) as first_at
      from pitboss.wallet_transactions x
     where x.wallet_id = w.id
  ) f on true
 where not exists (
   select 1
     from pitboss.wallet_transactions t
    where t.wallet_id = w.id
      and t.transaction_type = 'season_start_grant'
 );
