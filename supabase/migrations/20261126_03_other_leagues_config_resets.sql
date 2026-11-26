-- ============================================================================
-- 2026-11-26  Vector Racing Championship, W11 Racing Series and WSC: the
--             cap/wallet restatements that moved every team onto its current
--             starting wallet.
-- ============================================================================
--
-- What these rows are
-- -------------------
-- On 2026-11-08 the cap/wallet restructure re-baselined every league's wallets
-- in place: one manual_adjustment per wallet, related_type = 'config_reset',
-- described "Wallet reset to new starting wallet (cap/wallet restructure)".
-- 20261126_02 records TRL's 43. The three remaining leagues each moved their
-- 11 wallets the same way:
--
--   league                       division   wallets   grant         delta          balance
--   vector-racing-championship   F1_26         11     150,000,000   -110,000,000   40,000,000
--   w11-racing-series            T1            11     150,000,000   -110,000,000   40,000,000
--   wsc                          F1_26         11     150,000,000   -110,000,000   40,000,000
--
-- Unlike TRL, these three kept their opening balances: every one of the 33
-- wallets already has its 150,000,000 season_start_grant, dated
-- 2026-10-27 20:20:10.298, plus this restatement. Their ledgers were complete;
-- only the restatement rows were missing from the repository. So there is no
-- grant migration for them — just this one, and 20261126_01 must not be
-- extended to cover them (it is guarded per wallet, but the grants it would
-- write would be duplicates of rows that already exist there).
--
-- After this migration each of their wallets is reproduced exactly: the grant,
-- then the restatement, with balance_after = grant + delta = 40,000,000, which
-- is also the wallet's balance and its division's starting_wallet.
--
-- Dating
-- ------
-- The restatement happened once, at 2026-11-08 19:24:32.699106+00 — the same
-- instant as TRL's, twelve days after these grants. That exact timestamp is the
-- floor below, so the rebuilt ledger matches the live one. A wallet whose grant
-- is written later than that (a rebuild that seeds the grant at now()) gets its
-- restatement one minute after the grant instead, so the debit never precedes
-- the opening balance.
--
-- balance_after is the balance immediately after the restatement (grant +
-- delta), not the wallet's balance today: later activity is not this row's
-- business.
--
-- Idempotent: a wallet that already has a config_reset row is left alone, so
-- re-running this against the live database inserts nothing.
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
       greatest(coalesce(g.granted_at, timestamptz '2026-11-08 19:24:32.699106+00')
                  + interval '1 minute',
                timestamptz '2026-11-08 19:24:32.699106+00')
  from pitboss.franchise_wallets w
  join rise_os.leagues l
    on l.id = w.league_id
  join (values
          ('vector-racing-championship', 'F1_26', -110000000::numeric),
          ('w11-racing-series',          'T1',    -110000000::numeric),
          ('wsc',                        'F1_26', -110000000::numeric)
       ) as r(slug, division, delta)
    on r.slug = l.slug
   and r.division = w.division
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
