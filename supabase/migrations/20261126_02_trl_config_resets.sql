-- ============================================================================
-- 2026-11-26  TRL: the cap/wallet restatements that moved every team onto its
--             current starting wallet.
-- ============================================================================
--
-- What these rows are
-- -------------------
-- On 2026-11-08 the cap/wallet restructure re-baselined every league's wallets
-- in place: one manual_adjustment per wallet, related_type = 'config_reset',
-- described "Wallet reset to new starting wallet (cap/wallet restructure)".
-- TRL's 43 wallets moved like this:
--
--   division        old wallet   new wallet      delta
--   F1, F1_25       150,000,000   40,000,000   -110,000,000
--   F2_24, F2_25     40,000,000    7,500,000    -32,500,000
--
-- The restatement is an opening-balance correction, not spending: the wallet
-- and the division's starting_wallet moved together. /cap therefore excludes it
-- (PR #31), and the grant migration 20261126_01 supplies the other half of the
-- history. This migration supplies these rows, which until now existed only on
-- the live database.
--
-- Together the two migrations reproduce each TRL ledger exactly: one grant of
-- the old opening balance, then the restatement, and the wallet balance in the
-- middle equals grant + delta (40,000,000 in F1/F1_25, 7,500,000 in F2/F2_25).
--
-- Dating
-- ------
-- One minute after that wallet's season_start_grant, which is where it sits on
-- the live database (grants 2026-11-08 19:23:32.699 → resets 19:24:32.699). If
-- a wallet has no grant — this migration run on its own, before 20261126_01 —
-- the live timestamp is used instead, so the row still lands after any grant
-- inserted later.
--
-- balance_after is the balance immediately after the restatement (grant +
-- delta), not today's balance: later activity in the wallet is not this row's
-- business.
--
-- Idempotent: a wallet that already has a config_reset row is left alone, so
-- re-running this against the live database inserts nothing.
--
-- Out of scope: F1_26 and T1, whose wallets were created by
-- /api/admin/wallets/initialize after the restructure and never carried one.
-- ============================================================================

insert into pitboss.wallet_transactions
  (wallet_id, franchise_id, league_id, season, transaction_type, amount,
   balance_after, related_type, description, created_at)
select w.id,
       w.franchise_id,
       w.league_id,
       w.season,
       'manual_adjustment',
       r.delta,
       coalesce(g.opening_grant, 0) + r.delta,
       'config_reset',
       'Wallet reset to new starting wallet (cap/wallet restructure)',
       coalesce(g.granted_at + interval '1 minute',
                timestamptz '2026-11-08 19:24:32.699106+00')
  from pitboss.franchise_wallets w
  join rise_os.leagues l
    on l.id = w.league_id
   and l.slug = 'trl'
  join (values
          ('F1',    -110000000::numeric),
          ('F1_25', -110000000::numeric),
          ('F2_24',  -32500000::numeric),
          ('F2_25',  -32500000::numeric)
       ) as r(division, delta)
    on r.division = w.division
  left join lateral (
    select max(t.amount) as opening_grant,
           max(t.created_at) as granted_at
      from pitboss.wallet_transactions t
     where t.wallet_id = w.id
       and t.transaction_type = 'season_start_grant'
  ) g on true
 where not exists (
   select 1
     from pitboss.wallet_transactions t
    where t.wallet_id = w.id
      and t.transaction_type = 'manual_adjustment'
      and t.related_type = 'config_reset'
 );
