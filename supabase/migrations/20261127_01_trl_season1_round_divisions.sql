-- ============================================================================
-- 2026-11-27  TRL: season 1's rounds belong to the F1 26 divisions
-- ============================================================================
--
-- What this fixes
-- ---------------
-- The ten TRL divisions (20261126_04_trl_tier_divisions.sql) split each
-- franchise group into a T1 and a T2, but the season's 15 calendar rows were
-- left with division_id = null. null means "this round belongs to the whole
-- league", so /checkin in any division found every round, /calendar list
-- showed the same calendar in all ten, and a driver responding in T2 F1 26 was
-- answering a round that had nothing to do with their division.
--
-- The league's only season record is "TRL F1 26 Season" (season 1, active), so
-- these 15 rows — 12 races and 3 breaks — are the F1 26 calendar, and both of
-- F1 26's tiers race it. calendar_rounds carries one division_id per row, so
-- each tier needs its own copy: the existing rows become T1 F1 26's calendar
-- and are cloned for T2 F1 26. This is the same shape /calendar add already
-- writes when it is given a division, and the shape resolveRound() expects
-- (rows for the same round number in different divisions).
--
-- Other TRL divisions are deliberately left without a season-1 calendar: F1 25,
-- F2 24, F2 25 and F2 26 have no season record and no results yet, so their
-- check-in channels should say there is no upcoming round rather than borrow
-- F1 26's schedule. Assigning those calendars is a separate data change.
--
-- Safe to re-run
-- --------------
-- Step 1 only touches rows that still have division_id = null. Step 2 only
-- inserts a copy where the T2 F1 26 row for that league + season + round
-- number + type + name does not already exist, so re-running inserts nothing.
-- There are no check-ins, check-in posts or grid entries against these rounds
-- (verified before writing this), so no response loses its round.
-- ============================================================================

-- 1. The 15 rows are T1 F1 26's calendar.
update rise_os.calendar_rounds r
   set division_id = d.id
  from rise_os.leagues l,
       rise_os.league_divisions d
 where l.slug = 'trl'
   and r.league_id = l.id
   and r.season_number = 1
   and d.league_id = l.id
   and d.division_code = 'T1 F1 26'
   and r.division_id is null;

-- 2. Clone T1 F1 26's set for its T2 tier.
insert into rise_os.calendar_rounds (
  league_id,
  season_number,
  round_number,
  type,
  name,
  circuit,
  country,
  flag_emoji,
  race_date,
  break_start,
  break_end,
  break_label,
  is_sprint,
  status,
  division_id
)
select r.league_id,
       r.season_number,
       r.round_number,
       r.type,
       r.name,
       r.circuit,
       r.country,
       r.flag_emoji,
       r.race_date,
       r.break_start,
       r.break_end,
       r.break_label,
       r.is_sprint,
       r.status,
       t2.id
  from rise_os.calendar_rounds r
  join rise_os.leagues l
    on l.id = r.league_id
   and l.slug = 'trl'
  join rise_os.league_divisions t1
    on t1.league_id = l.id
   and t1.division_code = 'T1 F1 26'
  join rise_os.league_divisions t2
    on t2.league_id = l.id
   and t2.division_code = 'T2 F1 26'
 where r.season_number = 1
   and r.division_id = t1.id
   and not exists (
     select 1
       from rise_os.calendar_rounds c
      where c.league_id = r.league_id
        and c.season_number = r.season_number
        and c.division_id = t2.id
        and c.round_number is not distinct from r.round_number
        and c.type is not distinct from r.type
        and c.name is not distinct from r.name
   );
