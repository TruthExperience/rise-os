-- ============================================================================
-- 2026-11-26  TRL: the ten season-1 divisions (two tiers over five franchise
--             divisions).
-- ============================================================================
--
-- What TRL needs
-- --------------
-- TRL ran 2026 on one division per franchise group, and the Discord bot's
-- per-division features (check-in channels, /ddv, /regression, grid and
-- results scoping) key off rise_os.league_divisions rather than off franchises.
-- The league now wants each franchise division split into a T1 and a T2:
--
--   T1 F1 26   T2 F1 26     <- F1     (11 franchises)
--   T1 F1 25   T2 F1 25     <- F1_25  (10 franchises)
--   T1 F2 24   T2 F2 24     <- F2_24  (11 franchises)
--   T1 F2 25   T2 F2 25     <- F2_25  (11 franchises)
--   T1 F2 26   T2 F2 26     <- F2_26  ( 0 franchises yet)
--
-- Tier as a division row, not as a second set of franchises
-- ---------------------------------------------------------
-- This follows the shape VRC already uses ("T1 26" / "T2 26" pointing at
-- roster_division F1_26): the tier is a row in league_divisions whose
-- roster_division names the franchise division it draws from. Contracts, cap
-- configs, wallets and DDV stay keyed on the five franchise divisions (F1,
-- F1_25, F2_24, F2_25, F2_26), so nothing is duplicated or re-keyed here and
-- driver_contracts_division_check does not need widening.
--
-- max_drivers is two seats per franchise in the source division (22 / 20).
-- F2_26 has no franchises yet, so its cap is left null (unlimited) rather than
-- guessing a grid size.
--
-- The 2026-11-26 T1 row
-- ---------------------
-- /division create made one row before this migration: division_code "T1",
-- division_name "F1 26", tier_order 1, with its Discord check-in channel, role
-- and category already attached. That row is the T1 F1 26 division, so it is
-- renamed in place — its ids are kept, which is what keeps the existing
-- channel pointed at the right division.
--
-- Out of scope: calendar_rounds. The season's 15 rounds still have
-- division_id = null, which matches every division; assigning them (and
-- cloning F1's set for F1's T2) is a separate data change that needs the
-- league's round-to-division mapping.
--
-- Idempotent: the rename only matches a row still called "T1" and only when
-- "T1 F1 26" does not already exist; the insert skips codes that are present,
-- so re-running this against the live database changes nothing.
-- ============================================================================

-- The existing "T1" row is T1's F1 26 division: rename it and keep its
-- Discord ids. Skipped once the row has been renamed.
update rise_os.league_divisions d
   set division_code = 'T1 F1 26',
       division_name = 'T1 F1 26',
       roster_division = 'F1',
       tier_order = 1,
       max_drivers = 22
  from rise_os.leagues l
 where l.id = d.league_id
   and l.slug = 'trl'
   and d.division_code = 'T1'
   and not exists (
     select 1
       from rise_os.league_divisions x
      where x.league_id = d.league_id
        and x.division_code = 'T1 F1 26'
   );

insert into rise_os.league_divisions
  (league_id, division_code, division_name, roster_division, tier_order,
   max_drivers)
select l.id,
       v.division_code,
       v.division_code,
       v.roster_division,
       v.tier_order,
       v.max_drivers
  from rise_os.leagues l
  cross join (values
                ('T1 F1 26', 'F1',    1, 22),
                ('T2 F1 26', 'F1',    2, 22),
                ('T1 F1 25', 'F1_25', 1, 20),
                ('T2 F1 25', 'F1_25', 2, 20),
                ('T1 F2 24', 'F2_24', 1, 22),
                ('T2 F2 24', 'F2_24', 2, 22),
                ('T1 F2 25', 'F2_25', 1, 22),
                ('T2 F2 25', 'F2_25', 2, 22),
                ('T1 F2 26', 'F2_26', 1, null::integer),
                ('T2 F2 26', 'F2_26', 2, null::integer)
             ) as v(division_code, roster_division, tier_order, max_drivers)
 where l.slug = 'trl'
on conflict (league_id, division_code) do nothing;
