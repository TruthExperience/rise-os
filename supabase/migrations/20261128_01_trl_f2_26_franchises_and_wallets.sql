-- ============================================================================
-- 2026-11-28  TRL: F2_26's franchises, season-1 wallets, and the two division
--             checks that refused them.
-- ============================================================================
--
-- Why this file exists
-- --------------------
-- TRL opened an F2_26 grid but the database had no F2_26 franchises, and both
-- division CHECK constraints in front of them stopped short of the value:
--
--   rise_os.franchises.franchises_division_check        F1, F1_25, F1_26,
--                                                      F2_24, F2_25
--   pitboss.franchise_wallets.franchise_wallets_…
--     …_division_check                                  those plus T1
--
-- so inserting an F2_26 team failed with 23514, and even with the team in place
-- no F2_26 wallet could be created. (league_financial_config already had an
-- F2_26 row — $28M soft cap / $42M apron / $7.5M starting wallet — added
-- 2026-11-25, so the cap model was waiting for teams that could not exist.)
--
-- Applied to the live database on 2026-11-28 as ad-hoc SQL (constraint changes,
-- 11 franchises, 11 wallets and their opening grants) and recorded here so a
-- rebuilt database reproduces the same rows.
--
-- What is NOT here
-- ----------------
-- TRL's league_financial_config rows are seeded outside migrations (all five
-- divisions, including F2_26, predate this file), so a rebuild still needs them
-- from the league's own config source. The wallet step below therefore reads
-- the F2_26 starting_wallet when the row is present and falls back to the same
-- $7.5M the config holds, rather than assuming it.
--
-- Idempotent: both constraints are dropped-if-exists then re-added with the
-- same definition, and every insert is guarded by NOT EXISTS on the natural key
-- (league + division + name; franchise + league + season; wallet + grant), so
-- re-running against the live database inserts nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. rise_os.franchises: allow the F2_26 division.
-- ---------------------------------------------------------------------------
alter table rise_os.franchises
  drop constraint if exists franchises_division_check;

alter table rise_os.franchises
  add constraint franchises_division_check
  check (division = any (array['F1','F1_25','F1_26','F2_24','F2_25','F2_26']));

-- ---------------------------------------------------------------------------
-- 2. pitboss.franchise_wallets: allow F2_26 wallets (T1 is W11's).
-- ---------------------------------------------------------------------------
alter table pitboss.franchise_wallets
  drop constraint if exists franchise_wallets_division_check;

alter table pitboss.franchise_wallets
  add constraint franchise_wallets_division_check
  check (division = any (array['F1','F1_25','F1_26','F2_24','F2_25','F2_26','T1']));

-- ---------------------------------------------------------------------------
-- 3. The eleven F2_26 franchises, copied from the F2_25 grid with the 2026
--    logos the F2_25 rows already point at.
-- ---------------------------------------------------------------------------
insert into rise_os.franchises (league_id, name, abbreviation, division, logo_url)
select l.id, v.name, v.abbreviation, 'F2_26', v.logo_url
  from rise_os.leagues l
 cross join (values
   ('AIX Racing', 'AIX',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/aixracing/2026aixracinglogowhite.webp'),
   ('ART Grand Prix', 'ART',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/artgrandprix/2026artgrandprixlogowhite.webp'),
   ('Campos Racing', 'CAM',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/camposracing/2026camposracinglogowhite.webp'),
   ('DAMS', 'DAM',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/damslucasoil/2026damslucasoillogowhite.webp'),
   ('Hitech Grand Prix', 'HIT',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/hitech/2026hitechlogowhite.webp'),
   ('Invicta Racing', 'INV',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/invictaracing/2026invictaracinglogowhite.webp'),
   ('MP Motorsport', 'MPM',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/mpmotorsport/2026mpmotorsportlogowhite.webp'),
   ('PREMA Racing', 'PRE',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/premaracing/2026premaracinglogowhite.webp'),
   ('Rodin Motorsport', 'ROD',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/rodinmotorsport/2026rodinmotorsportlogowhite.webp'),
   ('Trident', 'TRI',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/trident/2026tridentlogowhite.webp'),
   ('Van Amersfoort Racing', 'VAR',
    'https://res.cloudinary.com/prod-f2f3/image/upload/c_lfill,w_64/q_auto/v1770000000/common/f2/2026/vanamersfoortracing/2026vanamersfoortracinglogowhite.webp')
 ) as v(name, abbreviation, logo_url)
 where l.slug = 'trl'
   and not exists (
     select 1
       from rise_os.franchises f
      where f.league_id = l.id
        and f.division = 'F2_26'
        and f.name = v.name
   );

-- ---------------------------------------------------------------------------
-- 4. Season-1 wallets for those franchises, at the division's starting_wallet.
-- ---------------------------------------------------------------------------
insert into pitboss.franchise_wallets
  (franchise_id, league_id, division, season, balance, starting_wallet,
   seasons_over_soft_cap, cap_freeze_active)
select f.id, f.league_id, 'F2_26', '1',
       coalesce(cfg.starting_wallet, 7500000),
       coalesce(cfg.starting_wallet, 7500000),
       0, false
  from rise_os.franchises f
  join rise_os.leagues l
    on l.id = f.league_id
   and l.slug = 'trl'
  left join lateral (
    select c.starting_wallet
      from pitboss.league_financial_config c
     where c.league_id = f.league_id
       and c.division = 'F2_26'
     order by c.effective_date desc nulls last, c.created_at desc
     limit 1
  ) cfg on true
 where f.division = 'F2_26'
   and not exists (
     select 1
       from pitboss.franchise_wallets w
      where w.franchise_id = f.id
        and w.league_id = f.league_id
        and w.season = '1'
   );

-- The opening grant each wallet's ledger starts with — the same row
-- /api/admin/wallets/initialize writes for a fresh season.
insert into pitboss.wallet_transactions
  (wallet_id, franchise_id, league_id, season, transaction_type, amount,
   balance_after, description)
select w.id, w.franchise_id, w.league_id, w.season, 'season_start_grant',
       w.starting_wallet, w.balance,
       'Season ' || w.season || ' starting wallet for TRL F2_26 ' ||
         '(league_financial_config starting_wallet)'
  from pitboss.franchise_wallets w
  join rise_os.leagues l
    on l.id = w.league_id
   and l.slug = 'trl'
 where w.division = 'F2_26'
   and w.season = '1'
   and not exists (
     select 1
       from pitboss.wallet_transactions t
      where t.wallet_id = w.id
        and t.transaction_type = 'season_start_grant'
   );
