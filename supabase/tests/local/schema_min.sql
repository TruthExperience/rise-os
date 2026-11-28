-- Minimal stand-in for the production schema, only as much as the migrations
-- touch. Every table and column here exists in Supabase qvychvzehuayowwjbfqy;
-- the three functions at the bottom are stubs for production functions this
-- harness does not need to exercise.
--
-- Loaded into a throwaway database by run.mjs. Never run against production.

drop schema if exists pitboss cascade;
drop schema if exists rise_os cascade;
drop schema if exists tests cascade;

create schema rise_os;
create schema pitboss;

create table rise_os.leagues (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text
);

create table rise_os.league_divisions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references rise_os.leagues(id),
  division_code text not null,
  division_name text,
  discord_checkin_channel_id text,
  created_at timestamptz not null default now(),
  discord_checkin_role_id text,
  discord_category_id text,
  tier_order integer not null default 1,
  max_drivers integer,
  discord_incident_channel_id text,
  discord_transcript_channel_id text,
  default_race_time time,
  race_timezone text not null default 'Europe/London',
  default_ping_delivery text,
  checkin_autopost_enabled boolean not null default false,
  roster_division text,
  unique (league_id, division_code)
);

create table rise_os.calendar_rounds (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references rise_os.leagues(id),
  season_number integer not null,
  round_number integer not null,
  type text not null default 'race',
  name text,
  circuit text,
  country text,
  flag_emoji text,
  race_date date,
  break_start date,
  break_end date,
  break_label text,
  is_sprint boolean not null default false,
  created_at timestamptz not null default now(),
  status text not null default 'scheduled',
  finalized_at timestamptz,
  finalized_by uuid,
  division_id uuid references rise_os.league_divisions(id)
);

create table pitboss.league_financial_config (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references rise_os.leagues(id),
  division text not null,
  effective_date date,
  created_at timestamptz not null default now(),
  soft_cap numeric not null,
  hard_apron numeric not null,
  starting_wallet numeric not null,
  dnf_parts_pct numeric not null default 0.02,
  performance_bonus_cap_pct numeric not null default 0.25,
  contract_floor_pct numeric not null default 1.00,
  contract_ceiling_pct numeric not null default 2.00,
  ddv_starting numeric not null default 1500000,
  rookie_contract_min numeric not null default 500000,
  rookie_contract_max numeric not null default 2000000,
  dead_cap_counts_soft boolean not null default true,
  dead_cap_counts_apron boolean not null default true
);

create table pitboss.drivers (
  id uuid primary key default gen_random_uuid(),
  discord_id text unique,
  clean_race_streak integer not null default 0
);

create table rise_os.franchises (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references rise_os.leagues(id),
  name text not null,
  abbreviation text,
  division text,
  logo_url text,
  created_at timestamptz not null default now()
);

create table pitboss.franchise_wallets (
  id uuid primary key default gen_random_uuid(),
  franchise_id uuid not null,
  league_id uuid not null references rise_os.leagues(id),
  division text not null,
  season text not null,
  balance numeric not null,
  starting_wallet numeric not null default 0,
  seasons_over_soft_cap integer not null default 0,
  cap_freeze_active boolean not null default false,
  updated_at timestamptz not null default now()
);

create table pitboss.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references pitboss.franchise_wallets(id),
  franchise_id uuid not null,
  league_id uuid not null,
  season text not null,
  transaction_type text not null check (transaction_type in (
    'manual_adjustment','season_start_grant','contract_signing','performance_bonus',
    'dnf_parts','fine','buyout','dead_cap','luxury_tax','prize','other')),
  amount numeric not null,
  balance_after numeric,
  related_id uuid,
  related_type text,
  description text,
  created_at timestamptz not null default now()
);

create table pitboss.driver_contracts (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  franchise_id uuid not null,
  league_id uuid not null references rise_os.leagues(id),
  contract_class text,
  division text not null,
  tier text,
  season_start text not null,
  season_end text,
  base_salary_per_season jsonb,
  signing_bonus numeric default 0,
  performance_bonuses jsonb,
  special_conditions text,
  status text not null default 'active',
  contract_value numeric,
  ddv_at_signing numeric,
  contract_floor numeric,
  contract_ceiling numeric,
  buyout_clause numeric,
  dead_cap_pct numeric default 0,
  is_rookie_contract boolean not null default false,
  hybrid_buffer_applied boolean not null default false,
  grace_period_sessions_remaining integer not null default 0,
  cooling_off_until timestamptz,
  released_at timestamptz,
  released_reason text,
  review_until timestamptz,
  review_reason text,
  source_document text,
  created_at timestamptz not null default now(),
  -- the live constraint this migration replaces
  constraint driver_contracts_division_check
    check (division = any (array['F1','F1_25','F1_26','F2_24','F2_25']))
);

create table pitboss.contract_earnings (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pitboss.driver_contracts(id),
  league_id uuid not null,
  franchise_id uuid not null,
  season text not null,
  round_id uuid,
  kind text not null,
  amount numeric not null,
  wallet_transaction_id uuid,
  created_at timestamptz not null default now(),
  clipped_amount numeric not null default 0,
  -- the live constraint this migration replaces (NULLS NOT DISTINCT is the bug).
  -- Production has it as a table constraint, not a bare index, so the stub must
  -- too: dropping the index alone fails with 2BP01 against the real database.
  constraint contract_earnings_contract_id_round_id_kind_key
    unique nulls not distinct (contract_id, round_id, kind),
  -- the live kind CHECK, which does not yet allow the sprint keys
  constraint contract_earnings_kind_check check (
    kind = any (array['race_win','podium','fastest_lap','pole','dnf_parts'])
    or kind ~ '^(wdc|wcc)_[a-z0-9_]+$'
  )
);

create table pitboss.results (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  driver_id uuid not null,
  season text not null,
  round integer,
  round_id uuid,
  track text,
  qualifying_position integer,
  finish_position integer,
  dnf boolean default false,
  dnf_reason text,
  fastest_lap boolean default false,
  sprint_qualifying_position integer,
  sprint_finish_position integer,
  sprint_dnf boolean default false,
  sprint_fastest_lap boolean default false,
  points_earned numeric,
  franchise_id uuid
);

create table pitboss.incidents (
  id uuid primary key default gen_random_uuid(),
  round_id uuid,
  accused_driver_id uuid,
  reported_by uuid,
  incident_type text,
  status text not null default 'open',
  verdict text
);

create table pitboss.penalty_ledger (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid,
  league_id uuid,
  round_id uuid,
  points integer,
  reason text,
  source text,
  issued_by uuid,
  removed_at timestamptz
);

create table pitboss.driver_ddv (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  league_id uuid not null,
  current_ddv numeric,
  career_peak_ddv numeric,
  tier_at_calc text
);

create table pitboss.driver_ddv_history (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid,
  league_id uuid,
  round_id uuid,
  event_type text,
  ddv_before numeric,
  recorded_at timestamptz not null default now()
);

create table pitboss.driver_standings (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  season text not null,
  driver_id uuid not null,
  starts integer default 0,
  wins integer default 0,
  points numeric default 0
);

create table pitboss.constructor_standings (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  season text not null,
  franchise_id uuid not null,
  wins integer default 0,
  points numeric default 0
);

-- ---- production helpers, stubbed -------------------------------------------

create or replace function pitboss.season_num(p text)
returns integer language sql immutable as $fn$
  select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '')::int;
$fn$;

create or replace function pitboss.rolling_ddv(p_driver uuid, p_league uuid, p_window integer)
returns numeric language sql stable as $fn$
  select coalesce(
    (select current_ddv from pitboss.driver_ddv
      where driver_id = p_driver and league_id = p_league),
    (select ddv_starting from pitboss.league_financial_config
      where league_id = p_league order by created_at desc limit 1),
    1500000);
$fn$;

create or replace function pitboss.log_contract_event(
  p_contract uuid, p_league uuid, p_driver uuid, p_event text, p_actor text, p_payload jsonb
) returns void language plpgsql as $fn$
begin
  return;
end;
$fn$;

-- ---- assertion helpers -----------------------------------------------------

create schema tests;

create table tests.log (
  id serial primary key,
  label text not null
);

create or replace function tests.ok(p_label text, p_cond boolean)
returns void language plpgsql as $fn$
begin
  if p_cond is not true then
    raise exception 'FAIL %', p_label;
  end if;
  insert into tests.log (label) values (p_label);
  raise notice 'ok  %', p_label;
end;
$fn$;

create or replace function tests.eq_num(p_label text, p_actual numeric, p_expected numeric)
returns void language plpgsql as $fn$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  insert into tests.log (label) values (p_label);
  raise notice 'ok  %', p_label;
end;
$fn$;

create or replace function tests.eq_text(p_label text, p_actual text, p_expected text)
returns void language plpgsql as $fn$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  insert into tests.log (label) values (p_label);
  raise notice 'ok  %', p_label;
end;
$fn$;

create or replace function tests.eq_int(p_label text, p_actual bigint, p_expected bigint)
returns void language plpgsql as $fn$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  insert into tests.log (label) values (p_label);
  raise notice 'ok  %', p_label;
end;
$fn$;
