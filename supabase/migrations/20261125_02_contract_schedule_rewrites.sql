-- ============================================================================
-- 2026-11-25  Part 2 of 2: create_driver_contract and edit_driver_contract
--             accept a keyed bonus schedule (or a template) and refuse the
--             unkeyed pool that made bonuses unpayable.
--
-- REQUIRES PART 1 (helpers contract_bonus_schedule / validate_bonus_schedule,
-- contract_templates). Land 20261125_01_* first.
--
-- TEST: supabase/tests/local/run.sh
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 9. create_driver_contract: keyed schedule, ceiling flag, no pool
-- ---------------------------------------------------------------------------
drop function if exists pitboss.create_driver_contract(
  uuid, uuid, uuid, text, text, integer, numeric, text, text, numeric, numeric, text, boolean, text, boolean);

create function pitboss.create_driver_contract(
  p_driver uuid,
  p_league uuid,
  p_franchise uuid,
  p_division text,
  p_season_start text,
  p_seasons integer default 1,
  p_value numeric default null,
  p_contract_class text default null,
  p_tier text default null,
  p_signing_bonus numeric default 0,
  p_performance_bonus numeric default 0,
  p_special_conditions text default null,
  p_is_rookie boolean default false,
  p_actor text default null,
  p_dry_run boolean default true,
  p_bonus_schedule jsonb default null,
  p_template text default null
)
returns jsonb
language plpgsql
set search_path to pitboss, rise_os, public
as $fn$
#variable_conflict use_column
declare
  cfg pitboss.league_financial_config;
  v_errs text[] := '{}';
  v_flags text[] := '{}';
  v_stub pitboss.driver_contracts;
  v_ddv_row pitboss.driver_ddv;
  v_ddv numeric;
  v_seeded boolean := false;
  v_floor numeric;
  v_ceil numeric;
  v_start integer;
  v_seasons integer := greatest(coalesce(p_seasons, 1), 1);
  v_season_end text;
  v_races integer;
  v_prior boolean;
  v_pay record;
  v_before numeric;
  v_drop numeric;
  v_review_until timestamptz;
  v_review_reason text;
  v_id uuid;
  v_class text;
  v_salary jsonb := '{}'::jsonb;
  v_bonus jsonb;
  v_signing numeric := coalesce(p_signing_bonus, 0);
  v_perf numeric := coalesce(p_performance_bonus, 0);
  i integer;
begin
  select * into cfg from pitboss.league_financial_config
   where league_id = p_league and division = p_division
   order by effective_date desc nulls last, created_at desc limit 1;
  if cfg.id is null then
    return jsonb_build_object('ok', false, 'dry_run', p_dry_run,
      'errors', jsonb_build_array('No league_financial_config for division ' || coalesce(p_division, 'null') || ' in this league.'));
  end if;

  if p_value is null or p_value <= 0 then
    v_errs := array_append(v_errs, 'Contract value must be greater than zero.');
  end if;
  if v_signing < 0 or v_perf < 0 then
    v_errs := array_append(v_errs, 'Signing and performance bonuses cannot be negative.');
  end if;

  v_start := pitboss.season_num(p_season_start);
  if v_start is null then
    v_errs := array_append(v_errs, 'Season must contain a number.');
    return jsonb_build_object('ok', false, 'dry_run', p_dry_run, 'errors', to_jsonb(v_errs));
  end if;
  v_season_end := (v_start + v_seasons - 1)::text;

  -- ---- bonus schedule: explicit keys, or a template. A bare pool is refused.
  if p_bonus_schedule is not null then
    v_bonus := p_bonus_schedule;
  elsif p_template is not null then
    select t.bonus_schedule into v_bonus
      from pitboss.contract_templates t
     where t.league_id = p_league and t.division = p_division and t.name = p_template
     order by t.created_at desc limit 1;
    if v_bonus is null then
      v_errs := array_append(v_errs,
        format('No bonus template named "%s" for division %s.', p_template, p_division));
    end if;
  elsif v_perf > 0 then
    v_errs := array_append(v_errs,
      'A performance-bonus pool is no longer accepted: pass a keyed schedule or a template (e.g. win=30000,podium=20000).');
  end if;

  if v_bonus is not null then
    v_errs := v_errs || pitboss.validate_bonus_schedule(v_bonus);
    select coalesce(sum(amount), 0) into v_perf
      from pitboss.contract_bonus_schedule(v_bonus);
    -- The ceiling is enforced at payout, not here: only flag it.
    if p_value is not null and p_value > 0 and v_perf > 0
       and v_perf > p_value * cfg.performance_bonus_cap_pct then
      v_flags := array_append(v_flags, 'bonus_schedule_exceeds_25pct_ceiling');
    end if;
  end if;

  select * into v_stub from pitboss.driver_contracts
   where driver_id = p_driver and league_id = p_league and status = 'active'
   order by created_at desc limit 1;
  if v_stub.id is not null then
    if v_stub.contract_value is not null then
      v_errs := array_append(v_errs, ('Driver already has an active contract (' || left(v_stub.id::text, 8) ||
        '). Release it or use /contract edit.'));
    elsif v_stub.franchise_id <> p_franchise then
      v_errs := array_append(v_errs, 'The unfinished contract on file belongs to a different franchise.');
    end if;
  end if;

  select * into v_ddv_row from pitboss.driver_ddv where driver_id = p_driver and league_id = p_league;
  if v_ddv_row.id is null then
    v_ddv := cfg.ddv_starting;
    v_seeded := true;
    v_flags := array_append(v_flags, 'ddv_seeded_at_starting_value');
  else
    v_ddv := pitboss.rolling_ddv(p_driver, p_league, 3);
  end if;

  if p_is_rookie then
    select count(*) into v_races from pitboss.results where driver_id = p_driver and league_id = p_league;
    select exists (select 1 from pitboss.driver_contracts c
                    where c.driver_id = p_driver and c.league_id = p_league
                      and c.contract_value is not null
                      and (v_stub.id is null or c.id <> v_stub.id)) into v_prior;
    if v_races >= 5 or v_prior then
      v_errs := array_append(v_errs, 'Not Rookie Contract eligible: only drivers in their first season with fewer than 5 races (DDV Regs 4.01).');
    end if;
    if v_seasons > 1 then
      v_errs := array_append(v_errs, 'Rookie Contracts are capped at one season (DDV Regs 4.01).');
    end if;
    v_floor := cfg.rookie_contract_min;
    v_ceil := cfg.rookie_contract_max;
  else
    v_floor := round(v_ddv * cfg.contract_floor_pct, 2);
    v_ceil := round(v_ddv * cfg.contract_ceiling_pct, 2);
  end if;

  if p_value is not null and p_value > 0 then
    if p_value < v_floor then
      v_errs := array_append(v_errs, ('Value $' || to_char(p_value, 'FM999,999,999,990') || ' is below the floor of $' ||
        to_char(v_floor, 'FM999,999,999,990') || '.'));
    elsif p_value > v_ceil then
      v_errs := array_append(v_errs, ('Value $' || to_char(p_value, 'FM999,999,999,990') || ' is above the ceiling of $' ||
        to_char(v_ceil, 'FM999,999,999,990') || '.'));
    end if;

    select * into v_pay from pitboss.franchise_cap_payroll(p_league, p_franchise, p_division, p_season_start);
    if v_pay.apron_payroll + p_value > cfg.hard_apron then
      v_errs := array_append(v_errs, ('Would push apron payroll to $' || to_char(v_pay.apron_payroll + p_value, 'FM999,999,999,990') ||
        ', over the hard apron of $' || to_char(cfg.hard_apron, 'FM999,999,999,990') || '. Blocked (Charter Art 6.02).'));
    elsif v_pay.soft_payroll + p_value > cfg.soft_cap then
      v_flags := array_append(v_flags, 'over_soft_cap_luxury_tax_applies');
    end if;
  end if;

  if v_ddv_row.id is not null then
    select h.ddv_before into v_before from pitboss.driver_ddv_history h
     where h.driver_id = p_driver and h.league_id = p_league
       and h.recorded_at >= now() - interval '28 days'
     order by h.recorded_at asc limit 1;
    if v_before is not null and v_before > 0 then
      v_drop := (v_before - v_ddv_row.current_ddv) / v_before;
      if v_drop > 0.25 then
        v_review_until := now() + interval '48 hours';
        v_review_reason := 'DDV fell ' || round(v_drop * 100, 1) || '% in the 4 weeks before signing (DDV Regs 4.01.1)';
        v_flags := array_append(v_flags, 'crrb_48h_review');
      end if;
    end if;
  end if;

  if array_length(v_errs, 1) is not null then
    return jsonb_build_object('ok', false, 'dry_run', p_dry_run, 'errors', to_jsonb(v_errs),
      'flags', to_jsonb(v_flags), 'ddv_basis', v_ddv, 'floor', v_floor, 'ceiling', v_ceil);
  end if;

  if not p_dry_run then
    if v_seeded then
      insert into pitboss.driver_ddv (driver_id, league_id, current_ddv, career_peak_ddv, tier_at_calc)
      values (p_driver, p_league, cfg.ddv_starting, cfg.ddv_starting,
              coalesce(nullif(p_tier, ''), left(p_division, 2)));
    end if;

    for i in 0 .. v_seasons - 1 loop
      v_salary := v_salary || jsonb_build_object((v_start + i)::text, p_value);
    end loop;
    v_class := coalesce(nullif(p_contract_class, ''), v_stub.contract_class, 'T1');

    if v_stub.id is not null then
      update pitboss.driver_contracts set
        contract_class = v_class, division = p_division, tier = coalesce(nullif(p_tier, ''), v_stub.tier),
        season_start = v_start::text, season_end = v_season_end,
        base_salary_per_season = v_salary, signing_bonus = v_signing, performance_bonuses = v_bonus,
        special_conditions = p_special_conditions, contract_value = p_value,
        ddv_at_signing = v_ddv, contract_floor = v_floor, contract_ceiling = v_ceil,
        is_rookie_contract = p_is_rookie, review_until = v_review_until, review_reason = v_review_reason,
        source_document = 'discord:/contract create'
      where id = v_stub.id
      returning id into v_id;
    else
      insert into pitboss.driver_contracts
        (driver_id, franchise_id, league_id, contract_class, division, tier, season_start, season_end,
         base_salary_per_season, signing_bonus, performance_bonuses, special_conditions, status,
         contract_value, ddv_at_signing, contract_floor, contract_ceiling, is_rookie_contract,
         review_until, review_reason, source_document)
      values
        (p_driver, p_franchise, p_league, v_class, p_division, nullif(p_tier, ''), v_start::text, v_season_end,
         v_salary, v_signing, v_bonus, p_special_conditions, 'active',
         p_value, v_ddv, v_floor, v_ceil, p_is_rookie,
         v_review_until, v_review_reason, 'discord:/contract create')
      returning id into v_id;
    end if;

    perform pitboss.log_contract_event(v_id, p_league, p_driver,
      case when v_stub.id is not null then 'completed' else 'created' end, p_actor,
      jsonb_build_object('value', p_value, 'ddv_basis', v_ddv, 'floor', v_floor, 'ceiling', v_ceil,
                         'seasons', v_seasons, 'rookie', p_is_rookie, 'flags', to_jsonb(v_flags),
                         'bonus_schedule', v_bonus));
  end if;

  return jsonb_build_object('ok', true, 'dry_run', p_dry_run, 'contract_id', v_id,
    'completed_stub', v_stub.id is not null, 'value', p_value, 'ddv_basis', v_ddv,
    'floor', v_floor, 'ceiling', v_ceil, 'season_start', v_start::text, 'season_end', v_season_end,
    'rookie', p_is_rookie, 'flags', to_jsonb(v_flags), 'review_until', v_review_until,
    'bonus_schedule', v_bonus, 'bonus_total', v_perf,
    'apron_payroll_before', v_pay.apron_payroll, 'hard_apron', cfg.hard_apron);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. edit_driver_contract: keyed schedule, no pool, ceiling as a warning
-- ---------------------------------------------------------------------------
drop function if exists pitboss.edit_driver_contract(
  uuid, text, text, numeric, integer, numeric, numeric, numeric, text, boolean);

create function pitboss.edit_driver_contract(
  p_contract uuid,
  p_actor text,
  p_reason text,
  p_value numeric default null,
  p_seasons integer default null,
  p_dead_cap_pct numeric default null,
  p_buyout numeric default null,
  p_performance_bonus numeric default null,
  p_special_conditions text default null,
  p_dry_run boolean default true,
  p_bonus_schedule jsonb default null
)
returns jsonb
language plpgsql
set search_path to pitboss, rise_os, public
as $fn$
#variable_conflict use_column
declare
  c pitboss.driver_contracts;
  cfg pitboss.league_financial_config;
  v_errs text[] := '{}';
  v_flags text[] := '{}';
  v_new_value numeric;
  v_new_end text;
  v_start integer;
  v_seasons integer;
  v_salary jsonb;
  v_bonus jsonb;
  v_bonus_total numeric;
  v_pay record;
  v_old_hit numeric;
  v_new_hit numeric;
  i integer;
begin
  select * into c from pitboss.driver_contracts where id = p_contract for update;
  if not found then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('Contract not found.'));
  end if;
  if c.status <> 'active' then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('Only active contracts can be edited (this one is ' || c.status || ').'));
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('A reason is required.'));
  end if;
  if c.contract_value is null or c.contract_floor is null or c.contract_ceiling is null then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('This contract is unfinished. Use /contract create to complete it first.'));
  end if;

  select * into cfg from pitboss.league_financial_config
   where league_id = c.league_id and division = c.division
   order by effective_date desc nulls last, created_at desc limit 1;

  v_new_value := coalesce(p_value, c.contract_value);
  v_start := pitboss.season_num(c.season_start);
  v_seasons := case when p_seasons is not null then greatest(p_seasons, 1)
                    else greatest(coalesce(pitboss.season_num(c.season_end), v_start) - v_start + 1, 1) end;
  v_new_end := (v_start + v_seasons - 1)::text;

  if p_value is not null then
    if p_value <= 0 then v_errs := array_append(v_errs, 'Value must be greater than zero.');
    elsif p_value < c.contract_floor then
      v_errs := array_append(v_errs, ('Value is below this contract''s floor of $' || to_char(c.contract_floor, 'FM999,999,999,990') || '.'));
    elsif p_value > c.contract_ceiling then
      v_errs := array_append(v_errs, ('Value is above this contract''s ceiling of $' || to_char(c.contract_ceiling, 'FM999,999,999,990') || '.'));
    end if;
  end if;
  if c.is_rookie_contract and v_seasons > 1 then
    v_errs := array_append(v_errs, 'Rookie Contracts are capped at one season.');
  end if;
  if p_dead_cap_pct is not null and (p_dead_cap_pct < 0 or p_dead_cap_pct > 1) then
    v_errs := array_append(v_errs, 'Dead cap must be between 0 and 1 (e.g. 0.5 for 50%).');
  end if;
  if p_buyout is not null and p_buyout < 0 then
    v_errs := array_append(v_errs, 'Buyout cannot be negative.');
  end if;

  -- A bare pool would overwrite a keyed schedule with something that can never
  -- pay, so it is refused outright.
  if p_performance_bonus is not null and p_bonus_schedule is null then
    v_errs := array_append(v_errs,
      'p_performance_bonus is retired: pass a keyed p_bonus_schedule instead.');
  end if;

  if p_bonus_schedule is not null then
    v_errs := v_errs || pitboss.validate_bonus_schedule(p_bonus_schedule);
    v_bonus := p_bonus_schedule;
    select coalesce(sum(amount), 0) into v_bonus_total
      from pitboss.contract_bonus_schedule(v_bonus);
  else
    v_bonus := c.performance_bonuses;
    select coalesce(sum(amount), 0) into v_bonus_total
      from pitboss.contract_bonus_schedule(c.performance_bonuses);
  end if;

  if cfg.id is not null and v_bonus_total > v_new_value * cfg.performance_bonus_cap_pct then
    v_flags := array_append(v_flags, 'bonus_schedule_exceeds_25pct_ceiling');
  end if;

  if p_value is not null and cfg.id is not null and array_length(v_errs, 1) is null then
    select * into v_pay from pitboss.franchise_cap_payroll(c.league_id, c.franchise_id, c.division, c.season_start);
    -- Payroll is per season, so the hit being replaced is this contract's
    -- base for the season the payroll was measured in, not the whole deal.
    v_old_hit := case when c.grace_period_sessions_remaining > 0 then 0
                      else pitboss.contract_season_base(
                             c.base_salary_per_season, c.contract_value,
                             c.season_start, c.season_end, c.season_start) end;
    v_new_hit := case when c.grace_period_sessions_remaining > 0 then 0 else v_new_value end;
    if v_pay.apron_payroll - v_old_hit + v_new_hit > cfg.hard_apron then
      v_errs := array_append(v_errs, 'That change would push the franchise over the hard apron. Blocked.');
    end if;
  end if;

  if array_length(v_errs, 1) is not null then
    return jsonb_build_object('ok', false, 'errors', to_jsonb(v_errs), 'flags', to_jsonb(v_flags));
  end if;

  v_salary := '{}'::jsonb;
  for i in 0 .. v_seasons - 1 loop
    v_salary := v_salary || jsonb_build_object((v_start + i)::text, v_new_value);
  end loop;

  if not p_dry_run then
    update pitboss.driver_contracts set
      contract_value = v_new_value,
      season_end = v_new_end,
      base_salary_per_season = v_salary,
      dead_cap_pct = coalesce(p_dead_cap_pct, dead_cap_pct),
      buyout_clause = coalesce(p_buyout, buyout_clause),
      performance_bonuses = v_bonus,
      special_conditions = coalesce(p_special_conditions, special_conditions)
    where id = c.id;

    perform pitboss.log_contract_event(c.id, c.league_id, c.driver_id, 'edited', p_actor,
      jsonb_build_object('reason', p_reason,
        'before', jsonb_build_object('value', c.contract_value, 'season_end', c.season_end,
          'dead_cap_pct', c.dead_cap_pct, 'buyout', c.buyout_clause, 'conditions', c.special_conditions,
          'bonus_schedule', c.performance_bonuses),
        'after', jsonb_build_object('value', v_new_value, 'season_end', v_new_end,
          'dead_cap_pct', coalesce(p_dead_cap_pct, c.dead_cap_pct), 'buyout', coalesce(p_buyout, c.buyout_clause),
          'conditions', coalesce(p_special_conditions, c.special_conditions),
          'bonus_schedule', v_bonus)));
  end if;

  return jsonb_build_object('ok', true, 'dry_run', p_dry_run, 'contract_id', c.id,
    'driver_id', c.driver_id, 'old_value', c.contract_value, 'new_value', v_new_value,
    'old_season_end', c.season_end, 'new_season_end', v_new_end,
    'dead_cap_pct', coalesce(p_dead_cap_pct, c.dead_cap_pct),
    'buyout', coalesce(p_buyout, c.buyout_clause),
    'bonus_schedule', v_bonus, 'bonus_total', v_bonus_total, 'flags', to_jsonb(v_flags));
end;
$fn$;

