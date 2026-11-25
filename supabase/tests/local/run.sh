#!/usr/bin/env bash
# Runs the migrations against a throwaway PostgreSQL (PGlite, WASM) and then
# the assertions. No Supabase connection, no persistence, nothing to clean up.
#
#   bash supabase/tests/local/run.sh
#
# PGlite is installed under ${TMPDIR:-/tmp}/rise-sql-test so the project's own
# dependencies and lockfile are untouched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
tmp="${TMPDIR:-/tmp}/rise-sql-test"

mkdir -p "$tmp"
if [ ! -d "$tmp/node_modules/@electric-sql/pglite" ]; then
  echo "installing PGlite into $tmp (one-off)"
  ( cd "$tmp" && npm init -y >/dev/null 2>&1 && npm i @electric-sql/pglite --no-audit --no-fund >/dev/null )
fi

cd "$repo"
node "$here/run.mjs" "$tmp"
