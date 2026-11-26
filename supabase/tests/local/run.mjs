// Runs the migrations and the assertions against a throwaway PGlite
// database (real PostgreSQL compiled to WASM). Nothing here touches Supabase.
//
//   supabase/tests/local/run.sh          # installs PGlite in a temp dir, runs this
//   node supabase/tests/local/run.mjs /path/to/tmp-with-pglite
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const tmp = process.argv[2];
if (!tmp) {
  console.error('usage: node run.mjs <dir containing node_modules/@electric-sql/pglite>');
  process.exit(2);
}

const requireFromTmp = createRequire(join(tmp, 'noop.js'));
const pgliteEntry = requireFromTmp.resolve('@electric-sql/pglite');
const { PGlite } = await import(pathToFileURL(pgliteEntry).href);

const files = [
  'supabase/tests/local/schema_min.sql',
  'supabase/migrations/20261125_01_bonus_ceiling_and_divisions.sql',
  'supabase/migrations/20261125_02_contract_schedule_rewrites.sql',
  'supabase/migrations/20261126_01_trl_opening_balances.sql',
  'supabase/migrations/20261126_02_trl_config_resets.sql',
  'supabase/migrations/20261126_03_other_leagues_config_resets.sql',
  'supabase/migrations/20261126_04_trl_tier_divisions.sql',
  'supabase/tests/local/assertions.sql',
];

const db = new PGlite();
let failed = false;

for (const rel of files) {
  const sql = readFileSync(join(repo, rel), 'utf8');

  // A migration must never control its own transaction. If it does, running it
  // inside a BEGIN ... ROLLBACK verification would COMMIT for real, and the
  // "rolled back" run would silently apply everything.
  if (rel.startsWith('supabase/migrations/')) {
    const own = sql.match(/^\s*(begin|commit)\s*;\s*$/im);
    if (own) {
      failed = true;
      console.error(`FAILED   ${rel}`);
      console.error(
        `  contains its own "${own[1].toUpperCase()};" — the caller owns BEGIN/COMMIT, ` +
        'so a rollback verification cannot commit by accident. Remove it.'
      );
      break;
    }
  }

  try {
    await db.exec(sql);
    console.log(`applied  ${rel}`);
  } catch (err) {
    failed = true;
    console.error(`FAILED   ${rel}`);
    console.error(String(err.message ?? err));
    if (err.position) {
      const pos = Number(err.position);
      const upto = sql.slice(0, pos);
      const line = upto.split('\n').length;
      const col = pos - upto.lastIndexOf('\n');
      console.error(`  at line ${line}, column ${col}`);
      console.error('  near: ' + sql.slice(Math.max(0, pos - 200), pos + 120).replace(/\n/g, '\n        '));
    }
    break;
  }
}

if (!failed) {
  const { rows } = await db.query('select count(*)::int as n from tests.log');
  console.log(`\nALL ASSERTIONS PASSED (${rows[0].n})`);
}

await db.close();
process.exit(failed ? 1 : 0);
