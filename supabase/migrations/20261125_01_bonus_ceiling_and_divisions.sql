-- ============================================================================
-- 2026-11-25  Part 1 of 2: divisions, earnings indexes, bonus ceiling,
--             round/season payouts, signing-bonus debit, templates,
--             finalize_round.
--
-- Independent of the contract-creation rewrite in part 2. Safe to land alone.
-- Written against the live definitions in Supabase qvychvzehuayowwjbfqy.
-- Does NOT rewrite create_driver_contract or edit_driver_contract.
--
-- TEST: supabase/tests/local/run.sh (real Postgres via PGlite, throwaway db)
-- ============================================================================

begin;
-- ---------------------------------------------------------------------------
-- 1. Divisions: W11 (T1) and TRL F2_26
-- ---------------------------------------------------------------------------
alter table pitboss.driver_contracts
  drop constraint if exists driver_contracts_division_check;

alter table pitboss.driver_contracts
  add constraint driver_contracts_division_check
  check (division = any (array['F1','F1_25','F1_26','F2_24','F2_25','F2_26','T1']));

-- ---------------------------------------------------------------------------
-- 2. contract_earnings: separate per-round uniqueness from per-season awards
-- ---------------------------------------------------------------------------
drop index if exists pitboss.contract_earnings_contract_id_round_id_kind_key;

create unique index if not exists contract_earnings_round_kind_key
  on pitboss.contract_earnings (contract_id, round_id, kind)
  where round_id is not null;

create unique index if not exists contract_earnings_season_kind_key
  on pitboss.contract_earnings (contract_id, season, kind)
  where round_id is null;

create index if not exists contract_earnings_contract_season_idx
  on pitboss.contract_earnings (contract_id, season);

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- Keyed view over a schedule. Anything unkeyed yields no rows, which is the
-- intended outcome for legacy pools: they pay nothing rather than paying by
-- accident.
create or replace function pitboss.contract_bonus_schedule(p_schedule jsonb)
returns table (bonus_key text, amount numeric, grp text)
language sql
immutable
as $fn$
  select e->>'key',
         coalesce(nullif(e->>'amount', '')::numeric, 0),
         nullif(e->>'group', '')
  from jsonb_array_elements(
         case when jsonb_typeof(p_schedule) = 'array' then p_schedule else '[]'::jsonb end
       ) e
  where jsonb_typeof(e) = 'object'
    and coalesce(e->>'key', '') <> '';
$fn$;

-- Base salary for a season. Contract rows written by create_driver_contract use
-- bare-digit keys ("1","2","3"); older rows may use "S2", so try both.
create or replace function pitboss.contract_base_for_season(p_base jsonb, p_season text)
returns numeric
language sql
immutable
as $fn$
  select case
    when jsonb_typeof(p_base) <> 'object' then 0
    else coalesce(
      nullif(p_base ->> pitboss.season_num(p_season)::text, '')::numeric,
      nullif(p_base ->> ('S' || pitboss.season_num(p_season)), '')::numeric,
      nullif(p_base ->> p_season, '')::numeric,
      0)
  end;
$fn$;

-- 25% of the season's base, from the division's config.
create or replace function pitboss.contract_bonus_ceiling(p_contract uuid, p_season text)
returns numeric
language sql
stable
as $fn$
  select round(
           coalesce(
             -- base_salary_per_season is authoritative when present
             nullif(pitboss.contract_base_for_season(c.base_salary_per_season, p_season), 0),
             -- fall back to an even split of the deal for contracts written
             -- without the per-season map (e.g. /sign-driver's direct insert)
             coalesce(c.contract_value, 0) / greatest(
               coalesce(pitboss.season_num(c.season_end), pitboss.season_num(c.season_start))
                 - coalesce(pitboss.season_num(c.season_start), 0) + 1, 1)
           ) * coalesce(cfg.performance_bonus_cap_pct, 0), 2)
  from pitboss.driver_contracts c
  left join lateral (
    select f.performance_bonus_cap_pct
    from pitboss.league_financial_config f
    where f.league_id = c.league_id and f.division = c.division
    order by f.effective_date desc nulls last, f.created_at desc
    limit 1
  ) cfg on true
  where c.id = p_contract;
$fn$;

-- Bonus money already paid this season for this contract. DNF parts are a cost
-- to the team, not a bonus, so they never consume the ceiling.
create or replace function pitboss.contract_bonus_paid(p_contract uuid, p_season text)
returns numeric
language sql
stable
as $fn$
  select coalesce(sum(e.amount - coalesce(e.clipped_amount, 0)), 0)
  from pitboss.contract_earnings e
  where e.contract_id = p_contract
    and pitboss.season_num(e.season) = pitboss.season_num(p_season)
    and e.kind <> 'dnf_parts';
$fn$;

create or replace function pitboss.validate_bonus_schedule(p_schedule jsonb)
returns text[]
language plpgsql
immutable
as $fn$
declare
  v_errs text[] := '{}';
  v_known text[] := array[
    'race_win','podium','fastest_lap','pole',
    'sprint_win','sprint_podium','sprint_pole',
    'wdc_p1','wdc_p2','wdc_p3','wdc_top5','wcc_p1','wcc_top5'
  ];
  e record;
begin
  if p_schedule is null then
    return v_errs;
  end if;
  if jsonb_typeof(p_schedule) <> 'array' then
    return array['Bonus schedule must be a JSON array of {key, amount, group}.'];
  end if;
  for e in select * from pitboss.contract_bonus_schedule(p_schedule) loop
    if not (e.bonus_key = any (v_known)) then
      v_errs := array_append(v_errs, format('Unknown bonus key: %s', e.bonus_key));
    end if;
    if e.amount < 0 then
      v_errs := array_append(v_errs, format('Bonus %s cannot be negative.', e.bonus_key));
    end if;
  end loop;
  return v_errs;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Payroll: bonuses paid, not bonuses earned; parts reported separately
-- ---------------------------------------------------------------------------
drop function if exists pitboss.franchise_cap_payroll(uuid, uuid, text, text);

create function pitboss.franchise_cap_payroll(
  p_league uuid, p_franchise uuid, p_division text, p_season text
)
returns table (
  active_total numeric,
  dead_total numeric,
  soft_payroll numeric,
  apron_payroll numeric,
  parts_total numeric,
  bonus_total numeric
)
language plpgsql
stable
set search_path to pitboss, rise_os, public
as $fn$
#variable_conflict use_column
declare
  cfg pitboss.league_financial_config;
  v_active numeric;
  v_signing numeric;
  v_bonus numeric;
  v_parts numeric;
  v_dead numeric;
begin
  select * into cfg from pitboss.league_financial_config
   where league_id = p_league and division = p_division
   order by effective_date desc nulls last, created_at desc limit 1;

  select coalesce(sum(case when c.grace_period_sessions_remaining > 0 then 0
                           else coalesce(c.contract_value, 0) end), 0)
    into v_active
    from pitboss.driver_contracts c
   where c.league_id = p_league and c.franchise_id = p_franchise and c.division = p_division
     and c.status = 'active'
     and pitboss.season_num(c.season_start) <= pitboss.season_num(p_season)
     and pitboss.season_num(coalesce(c.season_end, c.season_start)) >= pitboss.season_num(p_season);

  -- Signing bonus is cash handed over when the deal was signed. Releasing the
  -- driver later must not refund it, so this deliberately ignores status.
  select coalesce(sum(coalesce(c.signing_bonus, 0)), 0) into v_signing
    from pitboss.driver_contracts c
   where c.league_id = p_league and c.franchise_id = p_franchise and c.division = p_division
     and pitboss.season_num(c.season_start) = pitboss.season_num(p_season);

  select coalesce(sum(e.amount - coalesce(e.clipped_amount, 0)), 0) into v_bonus
    from pitboss.contract_earnings e
    join pitboss.driver_contracts c on c.id = e.contract_id
   where e.league_id = p_league and e.franchise_id = p_franchise and c.division = p_division
     and pitboss.season_num(e.season) = pitboss.season_num(p_season)
     and e.kind <> 'dnf_parts';

  select coalesce(sum(e.amount), 0) into v_parts
    from pitboss.contract_earnings e
    join pitboss.driver_contracts c on c.id = e.contract_id
   where e.league_id = p_league and e.franchise_id = p_franchise and c.division = p_division
     and pitboss.season_num(e.season) = pitboss.season_num(p_season)
     and e.kind = 'dnf_parts';

  select coalesce(sum(coalesce(c.contract_value, 0) * c.dead_cap_pct), 0) into v_dead
    from pitboss.driver_contracts c
   where c.league_id = p_league and c.franchise_id = p_franchise and c.division = p_division
     and pitboss.season_num(c.season_start) = pitboss.season_num(p_season)
     and c.status in ('released', 'bought_out');

  active_total  := v_active + v_signing + v_bonus;
  dead_total    := v_dead;
  parts_total   := v_parts;
  bonus_total   := v_bonus;
  -- The cost cap covers parts charges; the apron is payroll only, so damage
  -- cannot by itself push a team past the signing gate.
  soft_payroll  := active_total + parts_total
                   + case when coalesce(cfg.dead_cap_counts_soft, true) then v_dead else 0 end;
  apron_payroll := active_total
                   + case when coalesce(cfg.dead_cap_counts_apron, true) then v_dead else 0 end;
  return next;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Round earnings: sprint keys, groups, clipping, fault-aware parts
-- ---------------------------------------------------------------------------
create or replace function pitboss.post_round_earnings(p_round_id uuid)
returns integer
language plpgsql
security definer
set search_path to pitboss, rise_os, public, pg_temp
as $fn$
declare
  r record;
  c pitboss.driver_contracts;
  cfg pitboss.league_financial_config;
  w pitboss.franchise_wallets;
  k record;
  v_ins uuid;
  v_tx uuid;
  v_n integer := 0;

  v_win boolean; v_podium boolean; v_fl boolean; v_pole boolean;
  v_swin boolean; v_spodium boolean; v_spole boolean;

  v_ceiling numeric; v_paid numeric; v_room numeric;
  v_payout numeric; v_clipped numeric;

  v_charge numeric;
  v_crash boolean;
  v_caused_by_other boolean;
begin
  for r in select * from pitboss.results where round_id = p_round_id loop

    select * into c from pitboss.driver_contracts
     where driver_id = r.driver_id and league_id = r.league_id and status = 'active'
       and contract_value is not null
       and pitboss.season_num(season_start) <= pitboss.season_num(r.season)
       and pitboss.season_num(coalesce(season_end, season_start)) >= pitboss.season_num(r.season)
     order by created_at desc limit 1;
    continue when c.id is null;

    select * into cfg from pitboss.league_financial_config
     where league_id = c.league_id and division = c.division
     order by effective_date desc nulls last, created_at desc limit 1;
    continue when cfg.id is null;

    select * into w from pitboss.franchise_wallets
     where franchise_id = c.franchise_id and league_id = c.league_id and division = c.division
       and pitboss.season_num(season) = pitboss.season_num(r.season);
    if w.id is null then
      raise warning 'post_round_earnings: no wallet for franchise % division % season %',
        c.franchise_id, c.division, r.season;
      continue;
    end if;

    -- what this result earned (race + sprint)
    v_win        := not coalesce(r.dnf, false) and r.finish_position = 1;
    v_podium     := not coalesce(r.dnf, false) and r.finish_position in (2, 3);
    v_fl         := coalesce(r.fastest_lap, false);
    v_pole       := r.qualifying_position = 1;
    v_swin       := not coalesce(r.sprint_dnf, false) and r.sprint_finish_position = 1;
    v_spodium    := not coalesce(r.sprint_dnf, false) and r.sprint_finish_position in (2, 3);
    v_spole      := r.sprint_qualifying_position = 1;

    -- Earned entries, collapsed so that only the highest amount in a shared
    -- group pays (WDC tiers). Ungrouped entries all pay.
    for k in
      with earned(bonus_key, hit) as (values
        ('race_win',    v_win),
        ('podium',      v_podium),
        ('fastest_lap', v_fl),
        ('pole',        v_pole),
        ('sprint_win',  v_swin),
        ('sprint_podium', v_spodium),
        ('sprint_pole', v_spole)
      ),
      avail as (
        select s.bonus_key, s.amount, coalesce(s.grp, s.bonus_key) as grp
        from pitboss.contract_bonus_schedule(c.performance_bonuses) s
        join earned e on e.bonus_key = s.bonus_key and e.hit
      ),
      ranked as (
        select av.*, row_number() over (partition by grp order by amount desc, bonus_key) as rn
        from avail av
      )
      select bonus_key, amount from ranked where rn = 1 and amount > 0
      order by amount desc, bonus_key
    loop
      v_ceiling := pitboss.contract_bonus_ceiling(c.id, r.season);
      v_paid    := pitboss.contract_bonus_paid(c.id, r.season);
      v_room    := greatest(coalesce(v_ceiling, 0) - coalesce(v_paid, 0), 0);
      v_payout  := least(k.amount, v_room);
      v_clipped := k.amount - v_payout;

      insert into pitboss.contract_earnings
        (contract_id, league_id, franchise_id, season, round_id, kind, amount, clipped_amount)
      values
        (c.id, c.league_id, c.franchise_id, r.season, p_round_id, k.bonus_key, k.amount, v_clipped)
      on conflict (contract_id, round_id, kind) where round_id is not null do nothing
      returning id into v_ins;
      continue when v_ins is null;

      v_n := v_n + 1;
      continue when v_payout <= 0;   -- fully clipped: recorded, no money moves

      update pitboss.franchise_wallets
         set balance = balance - v_payout, updated_at = now()
       where id = w.id
      returning * into w;

      insert into pitboss.wallet_transactions
        (wallet_id, franchise_id, league_id, season, transaction_type, amount,
         balance_after, related_id, related_type, description)
      values
        (w.id, w.franchise_id, w.league_id, w.season, 'performance_bonus', -v_payout,
         w.balance, c.id, 'contract',
         format('%s R%s: earned %s, paid %s, clipped %s',
                k.bonus_key, r.round, k.amount, v_payout, v_clipped))
      returning id into v_tx;

      update pitboss.contract_earnings set wallet_transaction_id = v_tx where id = v_ins;
    end loop;

    -- A DNF costs the team unless another driver caused it. Parts have to be
    -- replaced either way — mechanical failures are not free.
    --
    -- "Another driver caused it" is only accepted when a steward has actually
    -- ruled that way: a resolved guilty incident on this round, against a
    -- different driver, of a contact type, where either the DNF'd driver is
    -- the one who reported it or the reason itself describes contact.
    -- A guilty verdict against this driver never exempts them; a blank or
    -- unrecognised reason with nobody else found guilty still charges.
    v_crash := coalesce(r.dnf_reason, '')
               ~* '(collision|collided|contact|crash|crashed|spun|spin|wall|punt|rammed|taken out|dive.?bomb)';

    v_caused_by_other := exists (
      select 1 from pitboss.incidents i
       where i.round_id = p_round_id
         and i.status = 'resolved'
         and i.verdict = 'guilty'
         and i.accused_driver_id <> r.driver_id
         and coalesce(i.incident_type, '') ~* '(collis|contact|crash|spun|push|dive|rear|side|punt|ram)'
         and (i.reported_by = r.driver_id or v_crash));

    if coalesce(r.dnf, false) and not v_caused_by_other then
      v_charge := round(coalesce(c.contract_value, 0) * coalesce(cfg.dnf_parts_pct, 0), 2);

      if v_charge > 0 then
        insert into pitboss.contract_earnings
          (contract_id, league_id, franchise_id, season, round_id, kind, amount, clipped_amount)
        values
          (c.id, c.league_id, c.franchise_id, r.season, p_round_id, 'dnf_parts', v_charge, 0)
        on conflict (contract_id, round_id, kind) where round_id is not null do nothing
        returning id into v_ins;

        if v_ins is not null then
          v_n := v_n + 1;

          update pitboss.franchise_wallets
             set balance = balance - v_charge, updated_at = now()
           where id = w.id
          returning * into w;

          insert into pitboss.wallet_transactions
            (wallet_id, franchise_id, league_id, season, transaction_type, amount,
             balance_after, related_id, related_type, description)
          values
            (w.id, w.franchise_id, w.league_id, w.season, 'dnf_parts', -v_charge,
             w.balance, c.id, 'contract',
             format('At-fault DNF R%s (%s): parts %s',
                    r.round, coalesce(r.dnf_reason, 'no reason given'), v_charge))
          returning id into v_tx;

          update pitboss.contract_earnings set wallet_transaction_id = v_tx where id = v_ins;
        end if;
      end if;
    end if;
  end loop;

  return v_n;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Season-end awards: WDC tiers and WCC
-- ---------------------------------------------------------------------------
create or replace function pitboss.post_season_bonuses(
  p_league uuid,
  p_season text,
  p_dry_run boolean default true,
  p_allow_incomplete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to pitboss, rise_os, public, pg_temp
as $fn$
declare
  c record;
  cfg pitboss.league_financial_config;
  w pitboss.franchise_wallets;
  k record;
  v_wdc integer;
  v_wcc integer;
  v_ins uuid;
  v_tx uuid;
  v_ceiling numeric;
  v_paid numeric;
  v_room numeric;
  v_payout numeric;
  v_clipped numeric;
  v_rows jsonb := '[]'::jsonb;
  v_posted integer := 0;
  v_unfinished integer;
begin
  -- Season awards pay once, so paying them before the season is actually over
  -- would lock in a half-finished table for good. Preview anyway; refuse to
  -- post until every round is final or cancelled.
  select count(*) into v_unfinished
    from rise_os.calendar_rounds
   where league_id = p_league
     and season_number = pitboss.season_num(p_season)
     and coalesce(status, 'scheduled') not in ('final', 'cancelled');

  -- Not every league marks its rounds final (as of 2026-11-25 only W11 has
  -- any 'final' rounds; TRL, VRC and WSC have none), so the guard must be
  -- escapable by a commissioner rather than a hard wall. Dry runs always
  -- preview; a real run needs p_allow_incomplete => true in those leagues.
  if v_unfinished > 0 and not p_dry_run and not p_allow_incomplete then
    return jsonb_build_object(
      'ok', false,
      'dry_run', p_dry_run,
      'season', p_season,
      'posted', 0,
      'season_incomplete', true,
      'unfinished_rounds', v_unfinished,
      'forced', false,
      'errors', jsonb_build_array(format(
        'Season %s has %s round(s) not marked final or cancelled. Season awards pay once, so they cannot be posted early. Re-run with p_allow_incomplete => true if this league does not mark rounds final.',
        p_season, v_unfinished)));
  end if;

  -- Standings are league-wide (no division column), but a league can run
  -- several divisions -- TRL runs F1 and F2 in one league. Ranking league-wide
  -- would crown one F1 driver the F2 champion, so rank inside each division,
  -- taking the division from the contract that covers the season.
  for c in
    with season_contracts as (
      select dc.*
        from pitboss.driver_contracts dc
       where dc.league_id = p_league
         and dc.status = 'active'
         and dc.contract_value is not null
         and pitboss.season_num(dc.season_start) <= pitboss.season_num(p_season)
         and pitboss.season_num(coalesce(dc.season_end, dc.season_start)) >= pitboss.season_num(p_season)
    ),
    driver_division as (
      select distinct on (driver_id) driver_id, division
        from season_contracts
       order by driver_id, created_at desc
    ),
    constructor_division as (
      select distinct on (franchise_id, division) franchise_id, division
        from season_contracts
       order by franchise_id, division, created_at desc
    ),
    wdc as (
      select ds.driver_id, dd.division,
             row_number() over (partition by dd.division
                                order by ds.points desc, ds.wins desc, ds.driver_id) as pos
        from pitboss.driver_standings ds
        join driver_division dd on dd.driver_id = ds.driver_id
       where ds.league_id = p_league
         and pitboss.season_num(ds.season) = pitboss.season_num(p_season)
    ),
    wcc as (
      select cs.franchise_id, cd.division,
             row_number() over (partition by cd.division
                                order by cs.points desc, cs.wins desc, cs.franchise_id) as pos
        from pitboss.constructor_standings cs
        join constructor_division cd on cd.franchise_id = cs.franchise_id
       where cs.league_id = p_league
         and pitboss.season_num(cs.season) = pitboss.season_num(p_season)
    )
    select sc.*, wdc.pos as wdc_pos, wcc.pos as wcc_pos
      from season_contracts sc
      left join wdc on wdc.driver_id = sc.driver_id and wdc.division = sc.division
      left join wcc on wcc.franchise_id = sc.franchise_id and wcc.division = sc.division
  loop
    v_wdc := c.wdc_pos;
    v_wcc := c.wcc_pos;

    select * into cfg from pitboss.league_financial_config
     where league_id = c.league_id and division = c.division
     order by effective_date desc nulls last, created_at desc limit 1;
    continue when cfg.id is null;

    for k in
      with earned(bonus_key, hit) as (values
        ('wdc_p1',   v_wdc = 1),
        ('wdc_p2',   v_wdc = 2),
        ('wdc_p3',   v_wdc = 3),
        ('wdc_top5', v_wdc between 1 and 5),
        ('wcc_p1',   v_wcc = 1),
        ('wcc_top5', v_wcc between 1 and 5)
      ),
      avail as (
        select s.bonus_key, s.amount, coalesce(s.grp, s.bonus_key) as grp
        from pitboss.contract_bonus_schedule(c.performance_bonuses) s
        join earned e on e.bonus_key = s.bonus_key and e.hit
      ),
      ranked as (
        select av.*, row_number() over (partition by grp order by amount desc, bonus_key) as rn
        from avail av
      )
      select bonus_key, amount from ranked where rn = 1 and amount > 0
      order by amount desc, bonus_key
    loop
      v_ceiling := pitboss.contract_bonus_ceiling(c.id, p_season);
      v_paid    := pitboss.contract_bonus_paid(c.id, p_season);
      v_room    := greatest(coalesce(v_ceiling, 0) - coalesce(v_paid, 0), 0);
      v_payout  := least(k.amount, v_room);
      v_clipped := k.amount - v_payout;

      v_rows := v_rows || jsonb_build_object(
        'contract_id', c.id, 'driver_id', c.driver_id, 'franchise_id', c.franchise_id,
        'division', c.division, 'key', k.bonus_key,
        'earned', k.amount, 'paid', v_payout, 'clipped', v_clipped);

      continue when p_dry_run;

      select * into w from pitboss.franchise_wallets
       where franchise_id = c.franchise_id and league_id = c.league_id and division = c.division
         and pitboss.season_num(season) = pitboss.season_num(p_season);
      if w.id is null then
        raise warning 'post_season_bonuses: no wallet for franchise % division % season %',
          c.franchise_id, c.division, p_season;
        continue;
      end if;

      insert into pitboss.contract_earnings
        (contract_id, league_id, franchise_id, season, round_id, kind, amount, clipped_amount)
      values
        (c.id, c.league_id, c.franchise_id, p_season, null, k.bonus_key, k.amount, v_clipped)
      on conflict (contract_id, season, kind) where round_id is null do nothing
      returning id into v_ins;
      continue when v_ins is null;
      continue when v_payout <= 0;   -- fully clipped: recorded, no money moves

      update pitboss.franchise_wallets
         set balance = balance - v_payout, updated_at = now()
       where id = w.id
      returning * into w;

      insert into pitboss.wallet_transactions
        (wallet_id, franchise_id, league_id, season, transaction_type, amount,
         balance_after, related_id, related_type, description)
      values
        (w.id, w.franchise_id, w.league_id, w.season, 'performance_bonus', -v_payout,
         w.balance, c.id, 'contract',
         format('%s season %s: earned %s, paid %s, clipped %s',
                k.bonus_key, p_season, k.amount, v_payout, v_clipped))
      returning id into v_tx;

      update pitboss.contract_earnings set wallet_transaction_id = v_tx where id = v_ins;
      v_posted := v_posted + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'ok', true, 'dry_run', p_dry_run, 'season', p_season,
    'season_incomplete', v_unfinished > 0,
    'unfinished_rounds', v_unfinished,
    'forced', (v_unfinished > 0 and p_allow_incomplete),
    'warning', case when v_unfinished > 0
      then format('%s round(s) are still not marked final; awards were computed from current standings.', v_unfinished)
      else null end,
    'posted', v_posted, 'rows', v_rows);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Signing bonus debits the wallet once per contract, inside the same
--    transaction as the contract write.
-- ---------------------------------------------------------------------------
create or replace function pitboss.debit_signing_bonus()
returns trigger
language plpgsql
security definer
set search_path to pitboss, rise_os, public, pg_temp
as $fn$
declare
  w pitboss.franchise_wallets;
  v_already boolean;
begin
  if coalesce(new.signing_bonus, 0) <= 0 then
    return new;
  end if;
  if new.contract_value is null then
    return new;                              -- unfinished stub: nothing to pay
  end if;
  if tg_op = 'UPDATE' and old.contract_value is not null then
    return new;                              -- only the first completion pays
  end if;

  select exists (
    select 1 from pitboss.wallet_transactions wt
     where wt.related_id = new.id and wt.related_type = 'contract'
       and wt.transaction_type = 'contract_signing'
  ) into v_already;
  if v_already then
    return new;
  end if;

  select * into w from pitboss.franchise_wallets
   where franchise_id = new.franchise_id and league_id = new.league_id
     and division = new.division
     and pitboss.season_num(season) = pitboss.season_num(new.season_start)
   limit 1;
  -- A division can legitimately have no wallet yet (a division created before
  -- its wallets are seeded). Never block the signing: warn and leave the debit
  -- for a later reconciliation pass.
  if w.id is null then
    raise warning
      'debit_signing_bonus: no wallet for franchise % division % season % — signing bonus % not debited.',
      new.franchise_id, new.division, new.season_start, new.signing_bonus;
    return new;
  end if;

  update pitboss.franchise_wallets
     set balance = balance - new.signing_bonus, updated_at = now()
   where id = w.id
  returning * into w;

  insert into pitboss.wallet_transactions
    (wallet_id, franchise_id, league_id, season, transaction_type, amount,
     balance_after, related_id, related_type, description)
  values
    (w.id, w.franchise_id, w.league_id, w.season, 'contract_signing', -new.signing_bonus,
     w.balance, new.id, 'contract',
     format('Signing bonus, %s-season deal', coalesce(new.contract_class, 'standard')));

  return new;
end;
$fn$;

drop trigger if exists debit_signing_bonus on pitboss.driver_contracts;
create trigger debit_signing_bonus
  after insert or update of contract_value, signing_bonus on pitboss.driver_contracts
  for each row execute function pitboss.debit_signing_bonus();

-- ---------------------------------------------------------------------------
-- 8. Contract templates
-- ---------------------------------------------------------------------------
create table if not exists pitboss.contract_templates (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references rise_os.leagues(id) on delete cascade,
  division text not null,
  name text not null,
  bonus_schedule jsonb not null,
  created_at timestamptz not null default now(),
  unique (league_id, division, name)
);

-- Charlie Dack's T2 development schedule, quoted for VRC.
insert into pitboss.contract_templates (league_id, division, name, bonus_schedule)
select l.id, 'F1_26', 'T2 development',
       '[
          {"key":"race_win","amount":30000},
          {"key":"podium","amount":20000},
          {"key":"pole","amount":10000},
          {"key":"fastest_lap","amount":5000},
          {"key":"wdc_p1","amount":500000,"group":"wdc"},
          {"key":"wdc_p2","amount":250000,"group":"wdc"},
          {"key":"wdc_p3","amount":100000,"group":"wdc"},
          {"key":"wdc_top5","amount":50000,"group":"wdc"},
          {"key":"wcc_p1","amount":200000},
          {"key":"wcc_top5","amount":50000}
        ]'::jsonb
  from rise_os.leagues l
 where l.slug = 'vector-racing-championship'
on conflict (league_id, division, name) do nothing;

-- ---------------------------------------------------------------------------
-- 11. finalize_round: proper search_path, reports earnings, never blocks
-- ---------------------------------------------------------------------------
drop function if exists pitboss.finalize_round(uuid, uuid);

create function pitboss.finalize_round(p_round_id uuid, p_finalized_by uuid)
returns integer
language plpgsql
security definer
set search_path to pitboss, rise_os, public, pg_temp
as $fn$
declare
  v_open_incidents integer;
  v_result_count integer;
  v_league_id uuid;
  v_driver record;
  v_at_fault boolean;
  v_posted integer;
begin
  if exists (select 1 from rise_os.calendar_rounds where id = p_round_id and status in ('final', 'cancelled')) then
    raise exception 'Round % is already final or cancelled', p_round_id;
  end if;
  select count(*) into v_open_incidents from pitboss.incidents
   where round_id = p_round_id and status in ('open', 'under_review', 'appealed');
  if v_open_incidents > 0 then
    raise exception 'Cannot finalize round %: % incident(s) still open, under review, or under appeal', p_round_id, v_open_incidents;
  end if;
  select count(*) into v_result_count from pitboss.results where round_id = p_round_id;
  if v_result_count = 0 then
    raise exception 'Cannot finalize round %: no results entered', p_round_id;
  end if;
  select league_id into v_league_id from rise_os.calendar_rounds where id = p_round_id;

  for v_driver in select distinct r.driver_id from pitboss.results r where r.round_id = p_round_id loop
    select exists (select 1 from pitboss.incidents i
                    where i.round_id = p_round_id and i.accused_driver_id = v_driver.driver_id
                      and i.status = 'resolved' and i.verdict = 'guilty') into v_at_fault;
    if v_at_fault then
      update pitboss.drivers set clean_race_streak = 0 where id = v_driver.driver_id;
    else
      update pitboss.drivers set clean_race_streak = clean_race_streak + 1 where id = v_driver.driver_id;
      if (select clean_race_streak from pitboss.drivers where id = v_driver.driver_id) >= 3 then
        update pitboss.drivers set clean_race_streak = 0 where id = v_driver.driver_id;
        insert into pitboss.penalty_ledger (driver_id, league_id, round_id, points, reason, source, issued_by)
        values (v_driver.driver_id, v_league_id, p_round_id, -2, 'Clean-race decay (3 consecutive clean rounds)', 'decay', p_finalized_by);
      end if;
    end if;
  end loop;

  -- Non-blocking by design: a round must never be stuck because a bonus or
  -- parts row could not post. The count is returned so the caller can say
  -- "finalized, but no earnings" instead of showing a bare success.
  -- post_round_earnings is idempotent, so a later retry is safe.
  begin
    v_posted := pitboss.post_round_earnings(p_round_id);
  exception when others then
    v_posted := 0;
    raise warning 'post_round_earnings failed for round %: %', p_round_id, sqlerrm;
  end;

  update rise_os.calendar_rounds set status = 'final', finalized_at = now(), finalized_by = p_finalized_by
   where id = p_round_id;

  return v_posted;
end;
$fn$;

commit;
