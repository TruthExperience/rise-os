-- Behavioural assertions for the two migrations.
-- Every check either raises (FAIL) on the first wrong value or logs an 'ok'.
-- Fixtures use fixed UUIDs so the numbers below are easy to follow.

-- ---------------------------------------------------------------- fixtures
insert into rise_os.leagues (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'trl', 'TRL'),
  ('22222222-2222-2222-2222-222222222222', 'w11-racing-series', 'W11');

insert into pitboss.league_financial_config
  (league_id, division, soft_cap, hard_apron, starting_wallet, ddv_starting, dnf_parts_pct, performance_bonus_cap_pct)
values
  ('11111111-1111-1111-1111-111111111111', 'F1',     150000000, 175000000, 40000000, 6000000, 0.02, 0.25),
  ('11111111-1111-1111-1111-111111111111', 'F2_24',   28000000,  42000000,  7500000, 1500000, 0.02, 0.25),
  ('11111111-1111-1111-1111-111111111111', 'F2_26',   28000000,  42000000,  7500000, 1500000, 0.02, 0.25),
  ('22222222-2222-2222-2222-222222222222', 'T1',     150000000, 175000000, 40000000, 6000000, 0.02, 0.25);

insert into pitboss.drivers (id, discord_id) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'd1'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'd2'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'd3'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'd4'),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'd5'),
  ('bbbbbbbb-0000-0000-0000-000000000006', 'd6'),
  ('bbbbbbbb-0000-0000-0000-000000000007', 'd7'),
  ('bbbbbbbb-0000-0000-0000-000000000008', 'd8');

insert into pitboss.franchise_wallets
  (franchise_id, league_id, division, season, balance)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'F1', '1', 40000000),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'T1', '1', 40000000);

-- C1: the main subject. Base 1,000,000 -> ceiling 250,000.
insert into pitboss.driver_contracts
  (id, driver_id, franchise_id, league_id, contract_class, division, season_start, season_end,
   base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('cccccccc-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'T1', 'F1', '1', '1',
   '{"1": 1000000}'::jsonb, 0,
   '[{"key":"race_win","amount":30000},
     {"key":"podium","amount":20000},
     {"key":"pole","amount":10000},
     {"key":"fastest_lap","amount":5000},
     {"key":"wdc_p1","amount":500000,"group":"wdc"},
     {"key":"wdc_p2","amount":250000,"group":"wdc"},
     {"key":"wdc_p3","amount":100000,"group":"wdc"},
     {"key":"wdc_top5","amount":50000,"group":"wdc"},
     {"key":"wcc_p1","amount":200000},
     {"key":"wcc_top5","amount":50000}]'::jsonb,
   'active', 1000000, 0);

-- C2: parts tests.
insert into pitboss.driver_contracts
  (id, driver_id, franchise_id, league_id, contract_class, division, season_start, season_end,
   base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('cccccccc-0000-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'T1', 'F1', '1', '1',
   '{"1": 1000000}'::jsonb, 0,
   '[{"key":"race_win","amount":30000}]'::jsonb,
   'active', 1000000, 0);

-- C3: a legacy unkeyed pool. It must never pay anything.
insert into pitboss.driver_contracts
  (id, driver_id, franchise_id, league_id, contract_class, division, season_start, season_end,
   base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('cccccccc-0000-0000-0000-000000000003',
   'bbbbbbbb-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'T1', 'F1', '1', '1',
   '{"1": 1000000}'::jsonb, 0,
   '[{"label":"Performance bonus pool","amount":500000}]'::jsonb,
   'active', 1000000, 0);

insert into rise_os.calendar_rounds (id, league_id, season_number, round_number) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '1', 1),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '1', 2),
  ('dddddddd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '1', 3),
  ('dddddddd-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '1', 4),
  ('dddddddd-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '1', 5),
  ('dddddddd-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '1', 6),
  ('dddddddd-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', '1', 7);

-- ------------------------------------------------------- 1. helpers
do $t$
declare v numeric;
begin
  v := pitboss.contract_bonus_ceiling('cccccccc-0000-0000-0000-000000000001', '1');
  perform tests.eq_num('ceiling is 25% of the season base', v, 250000);

  perform tests.eq_int('keyed schedule exposes 10 entries',
    (select count(*) from pitboss.contract_bonus_schedule(
       (select performance_bonuses from pitboss.driver_contracts
         where id = 'cccccccc-0000-0000-0000-000000000001'))), 10);

  perform tests.eq_int('unkeyed object yields no schedule rows',
    (select count(*) from pitboss.contract_bonus_schedule('{"label":"pool","amount":1}'::jsonb)), 0);

  perform tests.eq_int('unknown key is rejected',
    (select cardinality(pitboss.validate_bonus_schedule('[{"key":"nonsense","amount":1}]'::jsonb))), 1);

  perform tests.eq_int('valid keyed schedule passes validation',
    (select cardinality(pitboss.validate_bonus_schedule('[{"key":"race_win","amount":1}]'::jsonb))), 0);
end
$t$;

-- --------------------------------------------------- 2. division CHECK
do $t$
begin
  insert into pitboss.driver_contracts
    (driver_id, franchise_id, league_id, division, season_start, season_end,
     base_salary_per_season, performance_bonuses, status, contract_value)
  values
    ('bbbbbbbb-0000-0000-0000-000000000006',
     'aaaaaaaa-0000-0000-0000-000000000002',
     '11111111-1111-1111-1111-111111111111',
     'F2_26', '1', '1', '{"1": 1000000}'::jsonb, '[]'::jsonb, 'active', 1000000);
  perform tests.ok('F2_26 contracts are accepted', true);
end
$t$;

do $t$
begin
  begin
    insert into pitboss.driver_contracts
      (driver_id, franchise_id, league_id, division, season_start, season_end,
       base_salary_per_season, performance_bonuses, status, contract_value)
    values
      ('bbbbbbbb-0000-0000-0000-000000000006',
       'aaaaaaaa-0000-0000-0000-000000000002',
       '11111111-1111-1111-1111-111111111111',
       'ZZ', '1', '1', '{"1": 1000000}'::jsonb, '[]'::jsonb, 'active', 1000000);
    raise exception 'division CHECK accepted ZZ';
  exception when check_violation then
    perform tests.ok('unknown divisions are still rejected', true);
  end;
end
$t$;

-- ------------------------------------------- 3. earnings index split
do $t$
begin
  insert into pitboss.contract_earnings (contract_id, league_id, franchise_id, season, kind, amount)
  values
    ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001', '2', 'wdc_p1', 500000),
    ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001', '3', 'wdc_p1', 500000);
  perform tests.ok('same season-end key allowed once per season', true);
end
$t$;

do $t$
begin
  begin
    insert into pitboss.contract_earnings (contract_id, league_id, franchise_id, season, kind, amount)
    values
      ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
       'aaaaaaaa-0000-0000-0000-000000000001', '2', 'wdc_p1', 500000);
    raise exception 'duplicate season-end award was accepted';
  exception when unique_violation then
    perform tests.ok('duplicate season-end award is blocked', true);
  end;
end
$t$;

-- ------------------------------------------------ 4. round earnings
insert into pitboss.results
  (league_id, driver_id, season, round, round_id, qualifying_position, finish_position, dnf, fastest_lap)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001',
   '1', 1, 'dddddddd-0000-0000-0000-000000000001', 1, 1, false, true);

do $t$
declare v_posted integer; v_bal numeric;
begin
  v_posted := pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000001');
  perform tests.eq_int('R1 posts win, pole and fastest lap', v_posted, 3);
  perform tests.eq_num('R1 pays 45,000',
    (select sum(amount) from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000001'), 45000);
  perform tests.eq_num('R1 clips nothing',
    (select sum(clipped_amount) from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000001'), 0);
  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform tests.eq_num('wallet debited 45,000', v_bal, 39955000);
end
$t$;

-- Fill the ceiling to 245,000, then a 30,000 win may only pay 5,000.
insert into pitboss.contract_earnings (contract_id, league_id, franchise_id, season, round_id, kind, amount)
values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', '1', null, 'podium', 200000);

insert into pitboss.results
  (league_id, driver_id, season, round, round_id, qualifying_position, finish_position, dnf, fastest_lap)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001',
   '1', 2, 'dddddddd-0000-0000-0000-000000000002', 5, 1, false, false);

do $t$
declare v_bal numeric;
begin
  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000002');
  perform tests.eq_num('payout is clipped to the room left', 
    (select amount - clipped_amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000002' and kind = 'race_win'), 5000);
  perform tests.eq_num('clipped part is recorded',
    (select clipped_amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000002' and kind = 'race_win'), 25000);
  perform tests.eq_num('paid total now equals the ceiling',
    pitboss.contract_bonus_paid('cccccccc-0000-0000-0000-000000000001', '1'), 250000);
  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform tests.eq_num('wallet debited only the 5,000 paid', v_bal, 39950000);
end
$t$;

-- ------------------------------------------------------- 5. DNF parts
insert into pitboss.incidents (round_id, accused_driver_id, status, verdict)
values ('dddddddd-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'resolved', 'guilty');

insert into pitboss.results
  (league_id, driver_id, season, round, round_id, dnf, dnf_reason)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001',
   '1', 3, 'dddddddd-0000-0000-0000-000000000003', true, 'Engine failure');

do $t$
declare v_bal numeric;
begin
  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000003');
  perform tests.eq_num('guilty verdict charges parts despite the wording',
    (select amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000003' and kind = 'dnf_parts'), 20000);
  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform tests.eq_num('wallet debited 20,000 parts', v_bal, 39930000);
end
$t$;

insert into pitboss.results
  (league_id, driver_id, season, round, round_id, dnf, dnf_reason)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   '1', 4, 'dddddddd-0000-0000-0000-000000000004', true, 'Engine failure'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   '1', 5, 'dddddddd-0000-0000-0000-000000000005', true, 'Collision');

do $t$
declare v_bal numeric;
begin
  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000004');
  perform tests.eq_num('mechanical DNF still costs the team',
    (select amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000004' and kind = 'dnf_parts'), 20000);

  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000005');
  perform tests.eq_num('crash with no incident also charges',
    (select amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000005' and kind = 'dnf_parts'), 20000);

  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform tests.eq_num('wallet debited for both DNFs', v_bal, 39890000);
end
$t$;

-- ------------------------------------------- 6. legacy unkeyed pool
insert into pitboss.results
  (league_id, driver_id, season, round, round_id, qualifying_position, finish_position, dnf, fastest_lap)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000003',
   '1', 6, 'dddddddd-0000-0000-0000-000000000006', 1, 1, false, false);

do $t$
begin
  perform tests.eq_int('legacy pool pays nothing',
    pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000006'), 0);
  perform tests.eq_int('legacy pool wrote no earnings',
    (select count(*) from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000006'), 0);
end
$t$;

-- ------------------------------------------------- 7. season awards
insert into pitboss.driver_standings (league_id, season, driver_id, wins, points) values
  ('11111111-1111-1111-1111-111111111111', '1', 'bbbbbbbb-0000-0000-0000-000000000001', 2, 500),
  ('11111111-1111-1111-1111-111111111111', '1', 'bbbbbbbb-0000-0000-0000-000000000002', 0, 300);

insert into pitboss.constructor_standings (league_id, season, franchise_id, wins, points) values
  ('11111111-1111-1111-1111-111111111111', '1', 'aaaaaaaa-0000-0000-0000-000000000001', 2, 800);

do $t$
declare v jsonb;
begin
  v := pitboss.post_season_bonuses('11111111-1111-1111-1111-111111111111', '1', true);

  perform tests.eq_int('WDC tiers collapse to the highest one',
    (select count(*) from jsonb_array_elements(v->'rows') e
      where e->>'contract_id' = 'cccccccc-0000-0000-0000-000000000001'
        and e->>'key' like 'wdc%'), 1);

  perform tests.eq_num('WDC P1 amount is the 500,000 tier',
    (select (e->>'earned')::numeric from jsonb_array_elements(v->'rows') e
      where e->>'contract_id' = 'cccccccc-0000-0000-0000-000000000001'
        and e->>'key' like 'wdc%'), 500000);

  perform tests.eq_int('WCC top five and winner stack',
    (select count(*) from jsonb_array_elements(v->'rows') e
      where e->>'contract_id' = 'cccccccc-0000-0000-0000-000000000001'
        and e->>'key' like 'wcc%'), 2);

  perform tests.eq_num('season awards are clipped to zero once the ceiling is full',
    (select sum((e->>'paid')::numeric) from jsonb_array_elements(v->'rows') e
      where e->>'contract_id' = 'cccccccc-0000-0000-0000-000000000001'), 0);

  perform tests.eq_text('dry run posts nothing', v->>'dry_run', 'true');
end
$t$;

-- ------------------------------------------------ 8. signing bonus
do $t$
declare v_bal numeric;
begin
  -- division with no wallet: must not raise
  insert into pitboss.driver_contracts
    (driver_id, franchise_id, league_id, division, season_start, season_end,
     base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value)
  values
    ('bbbbbbbb-0000-0000-0000-000000000005',
     'aaaaaaaa-0000-0000-0000-000000000003',
     '11111111-1111-1111-1111-111111111111',
     'F2_24', '1', '1', '{"1": 4000000}'::jsonb, 250000, '[]'::jsonb, 'active', 4000000);
  perform tests.ok('signing without a wallet does not block the contract', true);

  perform tests.eq_int('no signing debit when the division has no wallet',
    (select count(*) from pitboss.wallet_transactions where transaction_type = 'contract_signing'), 0);

  -- division with a wallet: one debit
  insert into pitboss.driver_contracts
    (driver_id, franchise_id, league_id, division, season_start, season_end,
     base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value)
  values
    ('bbbbbbbb-0000-0000-0000-000000000004',
     'aaaaaaaa-0000-0000-0000-000000000002',
     '22222222-2222-2222-2222-222222222222',
     'T1', '1', '1', '{"1": 6000000}'::jsonb, 250000, '[]'::jsonb, 'active', 6000000);
  perform tests.ok('T1 contracts are accepted', true);

  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  perform tests.eq_num('signing bonus debits the wallet once', v_bal, 39750000);
  perform tests.eq_int('exactly one signing transaction',
    (select count(*) from pitboss.wallet_transactions where transaction_type = 'contract_signing'), 1);

  update pitboss.driver_contracts set contract_value = 6500000
   where driver_id = 'bbbbbbbb-0000-0000-0000-000000000004';
  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  perform tests.eq_num('a later edit does not debit again', v_bal, 39750000);
  perform tests.eq_int('still one signing transaction after the edit',
    (select count(*) from pitboss.wallet_transactions where transaction_type = 'contract_signing'), 1);
end
$t$;

-- -------------------------------------- 9. create / edit rewrites
do $t$
declare v jsonb; v_id uuid; v_sched jsonb;
begin
  v := pitboss.create_driver_contract(
    p_driver        => 'bbbbbbbb-0000-0000-0000-000000000007',
    p_league        => '11111111-1111-1111-1111-111111111111',
    p_franchise     => 'aaaaaaaa-0000-0000-0000-000000000001',
    p_division      => 'F1',
    p_season_start  => '1',
    p_seasons       => 1,
    p_value         => 6000000,
    p_contract_class=> 'T1',
    p_signing_bonus => 0,
    p_bonus_schedule=> '[{"key":"race_win","amount":30000},{"key":"wdc_p1","amount":500000,"group":"wdc"}]'::jsonb,
    p_dry_run       => false);

  perform tests.eq_text('create with a keyed schedule succeeds', v->>'ok', 'true');
  v_id := (v->>'contract_id')::uuid;

  select performance_bonuses into v_sched from pitboss.driver_contracts where id = v_id;
  perform tests.eq_int('stored schedule is an array of 2', jsonb_array_length(v_sched), 2);
  perform tests.eq_text('stored schedule keeps its keys', v_sched->0->>'key', 'race_win');

  perform tests.eq_int('a bare pool is refused',
    (select count(*) from jsonb_array_elements(
       pitboss.create_driver_contract(
         p_driver        => 'bbbbbbbb-0000-0000-0000-000000000008',
         p_league        => '11111111-1111-1111-1111-111111111111',
         p_franchise     => 'aaaaaaaa-0000-0000-0000-000000000001',
         p_division      => 'F1',
         p_season_start  => '1',
         p_seasons       => 1,
         p_value         => 6000000,
         p_performance_bonus => 500000,
         p_dry_run       => true)->'errors') e
     where e::text like '%pool is no longer accepted%'), 1);

  perform tests.eq_int('edit refuses the retired pool field',
    (select count(*) from jsonb_array_elements(
       pitboss.edit_driver_contract(
         p_contract  => v_id,
         p_actor     => 'test',
         p_reason    => 'test',
         p_performance_bonus => 100000,
         p_dry_run   => true)->'errors') e
     where e::text like '%retired%'), 1);
end
$t$;

-- ------------------------------------------------ 10. finalize
insert into pitboss.results
  (league_id, driver_id, season, round, round_id, qualifying_position, finish_position, dnf)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000007',
   '1', 7, 'dddddddd-0000-0000-0000-000000000007', 3, 1, false);

do $t$
declare v_posted integer;
begin
  v_posted := pitboss.finalize_round(
    'dddddddd-0000-0000-0000-000000000007',
    'eeeeeeee-0000-0000-0000-000000000001');
  perform tests.eq_int('finalize returns the earnings count', v_posted, 1);
  perform tests.eq_text('round marked final',
    (select status from rise_os.calendar_rounds where id = 'dddddddd-0000-0000-0000-000000000007'),
    'final');
end
$t$;

-- ------------------------- 11. finalize never blocks on a failing bonus insert
insert into rise_os.calendar_rounds (id, league_id, season_number, round_number) values
  ('dddddddd-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', '1', 8);

insert into pitboss.results
  (league_id, driver_id, season, round, round_id, qualifying_position, finish_position, dnf)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000007',
   '1', 8, 'dddddddd-0000-0000-0000-000000000008', 1, 1, false);

create or replace function tests.break_earnings()
returns trigger language plpgsql as $fn$
begin
  if new.round_id = 'dddddddd-0000-0000-0000-000000000008' then
    raise exception 'simulated earnings failure';
  end if;
  return new;
end;
$fn$;

create trigger break_earnings before insert on pitboss.contract_earnings
  for each row execute function tests.break_earnings();

do $t$
declare v_posted integer;
begin
  v_posted := pitboss.finalize_round(
    'dddddddd-0000-0000-0000-000000000008',
    'eeeeeeee-0000-0000-0000-000000000001');
  perform tests.eq_int('a failing earnings insert does not abort the finalize', v_posted, 0);
  perform tests.eq_text('the round is still marked final',
    (select status from rise_os.calendar_rounds where id = 'dddddddd-0000-0000-0000-000000000008'),
    'final');
  perform tests.eq_int('no earnings were written for the broken round',
    (select count(*) from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000008'), 0);
end
$t$;

drop trigger break_earnings on pitboss.contract_earnings;
drop function tests.break_earnings();

-- ------------------------- 12. backwards compatibility of the new signature
-- A caller written before this migration passes exactly the original 15
-- positional arguments. It must still resolve and succeed.
do $t$
begin
  perform tests.eq_text('15-argument positional call still resolves',
    (pitboss.create_driver_contract(
       'bbbbbbbb-0000-0000-0000-000000000008'::uuid,
       '11111111-1111-1111-1111-111111111111'::uuid,
       'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
       'F1'::text,
       '1'::text,
       1,
       6000000::numeric,
       'T1'::text,
       null::text,
       0::numeric,
       0::numeric,
       null::text,
       false,
       'test'::text,
       false))->>'ok',
    'true');

  perform tests.eq_text('no schedule is stored when none is passed',
    (select coalesce(performance_bonuses::text, 'null')
       from pitboss.driver_contracts
      where driver_id = 'bbbbbbbb-0000-0000-0000-000000000008'),
    'null');
end
$t$;

-- ------------- 13. DNF rule: charged by default, exempt only when another
--                    driver was found guilty of causing it
insert into rise_os.calendar_rounds (id, league_id, season_number, round_number) values
  ('dddddddd-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', '1', 9),
  ('dddddddd-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', '1', 10),
  ('dddddddd-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', '1', 11);

insert into pitboss.results
  (league_id, driver_id, season, round, round_id, dnf, dnf_reason)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   '1', 9, 'dddddddd-0000-0000-0000-000000000009', true, null),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   '1', 10, 'dddddddd-0000-0000-0000-000000000010', true, 'Something odd happened'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   '1', 11, 'dddddddd-0000-0000-0000-000000000011', true, 'Collision');

-- another driver is found guilty of a collision; the DNF'd driver reported it
insert into pitboss.incidents
  (round_id, accused_driver_id, reported_by, incident_type, status, verdict)
values
  ('dddddddd-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002', 'collision', 'resolved', 'guilty');

do $t$
declare v_bal numeric;
begin
  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000009');
  perform tests.eq_num('blank reason still costs the team',
    (select amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000009' and kind = 'dnf_parts'), 20000);

  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000010');
  perform tests.eq_num('unrecognised reason still costs the team',
    (select amount from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000010' and kind = 'dnf_parts'), 20000);

  perform pitboss.post_round_earnings('dddddddd-0000-0000-0000-000000000011');
  perform tests.eq_int('a driver taken out by another driver is exempt',
    (select count(*) from pitboss.contract_earnings
      where round_id = 'dddddddd-0000-0000-0000-000000000011'), 0);

  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform tests.eq_num('wallet charged for both unexplained DNFs', v_bal, 39820000);
end
$t$;

-- ---------------- 14. season awards: real payout, then a second run pays 0
insert into rise_os.leagues (id, slug, name) values
  ('33333333-3333-3333-3333-333333333333', 'awards-test', 'Awards test');

insert into pitboss.league_financial_config
  (league_id, division, soft_cap, hard_apron, starting_wallet, ddv_starting)
values
  ('33333333-3333-3333-3333-333333333333', 'F1', 150000000, 175000000, 40000000, 6000000);

insert into pitboss.drivers (id, discord_id) values
  ('bbbbbbbb-0000-0000-0000-000000000009', 'd9');

insert into pitboss.franchise_wallets (franchise_id, league_id, division, season, balance)
values
  ('aaaaaaaa-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 'F1', '1', 40000000);

insert into pitboss.driver_contracts
  (id, driver_id, franchise_id, league_id, contract_class, division, season_start, season_end,
   base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('cccccccc-0000-0000-0000-000000000004',
   'bbbbbbbb-0000-0000-0000-000000000009',
   'aaaaaaaa-0000-0000-0000-000000000004',
   '33333333-3333-3333-3333-333333333333',
   'T1', 'F1', '1', '1',
   '{"1": 1000000}'::jsonb, 0,
   '[{"key":"wdc_p1","amount":100000},
     {"key":"wcc_p1","amount":50000},
     {"key":"wcc_top5","amount":25000}]'::jsonb,
   'active', 1000000, 0);

insert into pitboss.driver_standings (league_id, season, driver_id, wins, points) values
  ('33333333-3333-3333-3333-333333333333', '1', 'bbbbbbbb-0000-0000-0000-000000000009', 1, 250);

insert into pitboss.constructor_standings (league_id, season, franchise_id, wins, points) values
  ('33333333-3333-3333-3333-333333333333', '1', 'aaaaaaaa-0000-0000-0000-000000000004', 1, 250);

do $t$
declare v jsonb; v_bal numeric;
begin
  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '1', false);

  perform tests.eq_int('non-dry season run posts three awards',
    (v->>'posted')::int, 3);

  perform tests.eq_num('season awards pay 175,000 in total',
    (select coalesce(sum(amount - clipped_amount), 0) from pitboss.contract_earnings
      where contract_id = 'cccccccc-0000-0000-0000-000000000004'), 175000);

  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000004';
  perform tests.eq_num('season awards debit the wallet', v_bal, 39825000);

  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '1', false);

  perform tests.eq_int('second run posts nothing', (v->>'posted')::int, 0);
  perform tests.eq_int('second run adds no earnings rows',
    (select count(*) from pitboss.contract_earnings
      where contract_id = 'cccccccc-0000-0000-0000-000000000004'), 3);

  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000004';
  perform tests.eq_num('second run pays nothing', v_bal, 39825000);
end
$t$;

-- the same contract runs a second season: it collects again, but only once
update pitboss.driver_contracts
   set season_end = '2',
       base_salary_per_season = '{"1": 1000000, "2": 1000000}'::jsonb
 where id = 'cccccccc-0000-0000-0000-000000000004';

insert into pitboss.franchise_wallets (franchise_id, league_id, division, season, balance)
values ('aaaaaaaa-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 'F1', '2', 40000000);

insert into pitboss.driver_standings (league_id, season, driver_id, wins, points) values
  ('33333333-3333-3333-3333-333333333333', '2', 'bbbbbbbb-0000-0000-0000-000000000009', 1, 250);

insert into pitboss.constructor_standings (league_id, season, franchise_id, wins, points) values
  ('33333333-3333-3333-3333-333333333333', '2', 'aaaaaaaa-0000-0000-0000-000000000004', 1, 250);

do $t$
declare v jsonb; v_bal numeric;
begin
  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '2', false);
  perform tests.eq_int('a second season pays its awards again', (v->>'posted')::int, 3);

  select balance into v_bal from pitboss.franchise_wallets
   where franchise_id = 'aaaaaaaa-0000-0000-0000-000000000004' and season = '2';
  perform tests.eq_num('season 2 wallet debited 175,000', v_bal, 39825000);

  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '2', false);
  perform tests.eq_int('re-running season 2 pays nothing', (v->>'posted')::int, 0);
end
$t$;

-- an unfinished season cannot be paid early: it would lock in a partial table
insert into rise_os.calendar_rounds (id, league_id, season_number, round_number, status) values
  ('dddddddd-0000-0000-0000-000000000012', '33333333-3333-3333-3333-333333333333', 3, 1, 'scheduled');

do $t$
declare v jsonb;
begin
  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '3', false);
  perform tests.eq_text('an unfinished season refuses to pay', v->>'ok', 'false');
  perform tests.eq_int('the refusal posts nothing', (v->>'posted')::int, 0);

  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '3', true);
  perform tests.eq_text('a dry run still previews it', v->>'ok', 'true');
  perform tests.ok('the dry run reports the season as incomplete', (v->>'season_incomplete')::boolean);

  -- a league that never marks rounds final can still be paid, deliberately
  v := pitboss.post_season_bonuses('33333333-3333-3333-3333-333333333333', '3', false, true);
  perform tests.eq_text('the override permits an unfinished season', v->>'ok', 'true');
  perform tests.ok('the override is reported as forced', (v->>'forced')::boolean);
  perform tests.ok('the override still warns', (v->>'warning') is not null);
end
$t$;

-- ------- 15. champions are decided inside a division, not across the league
insert into rise_os.leagues (id, slug, name) values
  ('44444444-4444-4444-4444-444444444444', 'division-test', 'Division test');

insert into pitboss.league_financial_config
  (league_id, division, soft_cap, hard_apron, starting_wallet, ddv_starting)
values
  ('44444444-4444-4444-4444-444444444444', 'F1', 150000000, 175000000, 40000000, 6000000),
  ('44444444-4444-4444-4444-444444444444', 'F2_25', 28000000, 42000000, 7500000, 1500000);

insert into pitboss.drivers (id, discord_id) values
  ('bbbbbbbb-0000-0000-0000-000000000011', 'd11'),
  ('bbbbbbbb-0000-0000-0000-000000000012', 'd12');

insert into pitboss.driver_contracts
  (id, driver_id, franchise_id, league_id, contract_class, division, season_start, season_end,
   base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('cccccccc-0000-0000-0000-000000000005',
   'bbbbbbbb-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000006',
   '44444444-4444-4444-4444-444444444444', 'T1', 'F1', '1', '1',
   '{"1": 1000000}'::jsonb, 0,
   '[{"key":"wdc_p1","amount":100000,"group":"wdc"},
     {"key":"wdc_p2","amount":50000,"group":"wdc"}]'::jsonb,
   'active', 1000000, 0),
  ('cccccccc-0000-0000-0000-000000000006',
   'bbbbbbbb-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000007',
   '44444444-4444-4444-4444-444444444444', 'T1', 'F2_25', '1', '1',
   '{"1": 1000000}'::jsonb, 0,
   '[{"key":"wdc_p1","amount":100000,"group":"wdc"},
     {"key":"wdc_p2","amount":50000,"group":"wdc"}]'::jsonb,
   'active', 1000000, 0);

insert into pitboss.driver_standings (league_id, season, driver_id, wins, points) values
  ('44444444-4444-4444-4444-444444444444', '1', 'bbbbbbbb-0000-0000-0000-000000000011', 3, 300),
  ('44444444-4444-4444-4444-444444444444', '1', 'bbbbbbbb-0000-0000-0000-000000000012', 0, 200);

do $t$
declare v jsonb;
begin
  v := pitboss.post_season_bonuses('44444444-4444-4444-4444-444444444444', '1', true);

  perform tests.eq_text('F1 champion takes the P1 tier',
    (select e->>'key' from jsonb_array_elements(v->'rows') e
      where e->>'contract_id' = 'cccccccc-0000-0000-0000-000000000005' and e->>'key' like 'wdc%'),
    'wdc_p1');

  perform tests.eq_text('F2 champion takes P1 in its own division, not second overall',
    (select e->>'key' from jsonb_array_elements(v->'rows') e
      where e->>'contract_id' = 'cccccccc-0000-0000-0000-000000000006' and e->>'key' like 'wdc%'),
    'wdc_p1');
end
$t$;

-- ---- 16. a released contract keeps the signing bonus it already paid out
insert into pitboss.drivers (id, discord_id) values
  ('bbbbbbbb-0000-0000-0000-000000000013', 'd13');

insert into pitboss.driver_contracts
  (driver_id, franchise_id, league_id, contract_class, division, season_start, season_end,
   base_salary_per_season, signing_bonus, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('bbbbbbbb-0000-0000-0000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000008',
   '11111111-1111-1111-1111-111111111111', 'T1', 'F2_24', '1', '1',
   '{"1": 4000000}'::jsonb, 250000, '[]'::jsonb, 'released', 4000000, 0);

do $t$
declare p record;
begin
  select * into p from pitboss.franchise_cap_payroll(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-0000-0000-0000-000000000008', 'F2_24', '1');
  perform tests.eq_num('a released contract still counts its signing bonus', p.active_total, 250000);
end
$t$;

-- ---- 17. contracts without a per-season base map still get a ceiling
insert into pitboss.drivers (id, discord_id) values
  ('bbbbbbbb-0000-0000-0000-000000000014', 'd14');

insert into pitboss.driver_contracts
  (driver_id, franchise_id, league_id, division, season_start, season_end,
   base_salary_per_season, performance_bonuses, status, contract_value, dead_cap_pct)
values
  ('bbbbbbbb-0000-0000-0000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000009',
   '11111111-1111-1111-1111-111111111111', 'F1', '1', '3',
   null, '[]'::jsonb, 'active', 3000000, 0);

do $t$
begin
  perform tests.eq_num('ceiling falls back to an even split of the deal',
    (select pitboss.contract_bonus_ceiling(id, '2')
       from pitboss.driver_contracts
      where driver_id = 'bbbbbbbb-0000-0000-0000-000000000014'), 250000);
end
$t$;

-- ---- 18. reconciliation query: bonuses that were never debited
-- Mirrors supabase/queries/signing_bonus_reconciliation.sql.
do $t$
declare v_missing integer; v_fixable integer;
begin
  select count(*) into v_missing
    from pitboss.driver_contracts c
   where coalesce(c.signing_bonus, 0) > 0
     and c.contract_value is not null
     and not exists (
       select 1 from pitboss.wallet_transactions wt
        where wt.related_id = c.id and wt.related_type = 'contract'
          and wt.transaction_type = 'contract_signing');
  perform tests.eq_int('two signing bonuses are waiting to be debited', v_missing, 2);

  select count(*) into v_fixable
    from pitboss.driver_contracts c
   where coalesce(c.signing_bonus, 0) > 0
     and c.contract_value is not null
     and not exists (
       select 1 from pitboss.wallet_transactions wt
        where wt.related_id = c.id and wt.related_type = 'contract'
          and wt.transaction_type = 'contract_signing')
     and exists (
       select 1 from pitboss.franchise_wallets w
        where w.franchise_id = c.franchise_id and w.league_id = c.league_id
          and w.division = c.division
          and pitboss.season_num(w.season) = pitboss.season_num(c.season_start));
  perform tests.eq_int('neither has a wallet to debit yet', v_fixable, 0);
end
$t$;
