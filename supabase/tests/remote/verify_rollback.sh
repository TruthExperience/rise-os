#!/usr/bin/env bash
# Verify both migrations against a real database, then roll everything back.
#
#   DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres' \
#     bash supabase/tests/remote/verify_rollback.sh
#
# Nothing is applied: the whole file runs inside one transaction that ends in
# ROLLBACK. The migration files deliberately contain no BEGIN/COMMIT of their
# own, so they cannot commit the outer transaction behind your back — if you
# add one back, this script will silently apply the migrations, so don't.
#
# Use the direct/session connection string (port 5432), not the transaction
# pooler (6543), which does not support the single long transaction below.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a Postgres connection string for the target database}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
\echo '== opening transaction: everything below rolls back =='
begin;

\echo '== applying part 1 =='
\i supabase/migrations/20261125_01_bonus_ceiling_and_divisions.sql
\echo '== applying part 2 =='
\i supabase/migrations/20261125_02_contract_schedule_rewrites.sql

\echo '== functions created / replaced =='
select p.proname, pg_get_function_result(p.oid) as returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'pitboss'
   and p.proname in ('contract_season_base','contract_bonus_ceiling','contract_bonus_paid',
                     'validate_bonus_schedule','franchise_cap_payroll','post_round_earnings',
                     'post_season_bonuses','debit_signing_bonus','create_driver_contract',
                     'edit_driver_contract','finalize_round')
 order by 1;

\echo '== division CHECK =='
select pg_get_constraintdef(oid) as division_check
  from pg_constraint
 where conname = 'driver_contracts_division_check';

\echo '== earnings indexes =='
select indexname
  from pg_indexes
 where schemaname = 'pitboss' and tablename = 'contract_earnings'
 order by 1;

\echo '== templates =='
select count(*) as contract_templates from pitboss.contract_templates;

\echo '== signing trigger =='
select tgname from pg_trigger
 where tgrelid = 'pitboss.driver_contracts'::regclass and not tgisinternal
 order by 1;

\echo '== rolling back =='
rollback;

\echo '== after rollback (must show 0 rows, void return, old index) =='
select count(*) as post_season_bonuses_left
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'pitboss' and p.proname = 'post_season_bonuses';

select pg_get_function_result('pitboss.finalize_round(uuid,uuid)'::regprocedure) as finalize_returns;

select indexname
  from pg_indexes
 where schemaname = 'pitboss' and tablename = 'contract_earnings'
 order by 1;
SQL
