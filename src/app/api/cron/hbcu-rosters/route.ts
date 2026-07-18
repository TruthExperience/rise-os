// src/app/api/cron/hbcu-rosters/route.ts
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Pro plan required for >60s. Shard HBCU_SCHOOLS across runs if on Hobby.

// The 36 schools confirmed remaining in rise_os.franchises (league = HBCU) that
// have no rows yet in rise_os.hbcu_players, as of 2026-07-17.
const HBCU_SCHOOLS: { name: string; franchiseId: string }[] = [
  { name: 'Albany State University', franchiseId: '468949c7-1327-4001-b4cc-bbea6762884b' },
  { name: 'Barber-Scotia College', franchiseId: '112ba8fa-3314-4907-abb2-49848ca4b3f8' },
  { name: 'Benedict College', franchiseId: '2e1eb687-e30d-4006-9b9a-fcbcb8eeb2b2' },
  { name: 'Bluefield State University', franchiseId: '78275f71-7494-41f6-b243-b66a7caa8056' },
  { name: 'Bowie State University', franchiseId: '8d280be6-3eb1-4575-9714-de76a3809a0e' },
  { name: 'Central State University', franchiseId: '2389391a-a2d0-48bf-94d4-661f6a192c07' },
  { name: 'Clark Atlanta University', franchiseId: 'e35aadf6-dedc-4715-b390-c57eee6827e4' },
  { name: 'Coahoma Community College', franchiseId: '1fc247de-2f62-48b7-ac55-3444b91f1b85' },
  { name: 'Edward Waters University', franchiseId: 'cad5fd4e-e623-4c1b-8034-da8888f07bc2' },
  { name: 'Elizabeth City State University', franchiseId: '4c0f95b6-3f07-48de-be6f-43139f246bef' },
  { name: 'Fayetteville State University', franchiseId: '35904545-6c22-45de-877e-9607e646697a' },
  { name: 'Florida Memorial University', franchiseId: '8cb94747-651e-4bbf-936c-f7b4394767a9' },
  { name: 'Fort Valley State University', franchiseId: 'ff5f2c36-2c95-419e-be63-5ac208f2e5fe' },
  { name: 'Hampton University', franchiseId: '5967f98c-8afd-4a57-a159-2419eac56c16' },
  { name: 'Johnson C. Smith University', franchiseId: '90ae129f-6989-414e-bffd-53edef97a595' },
  { name: 'Kentucky State University', franchiseId: 'ee3093bf-702a-46cc-921b-19071d928b96' },
  { name: 'Lane College', franchiseId: '1703ff90-5d03-4d15-8a75-7856010ca4d5' },
  { name: 'Langston University', franchiseId: 'b0f329a8-f129-4a35-920f-2d99643f4b78' },
  { name: 'Lincoln University (MO)', franchiseId: '34103372-6adb-4912-92fe-eb18551873f0' },
  { name: 'Lincoln University (PA)', franchiseId: 'ee9987d5-4580-4ed4-8255-b6ddd0146e66' },
  { name: 'Livingstone College', franchiseId: '6c6d6a5c-14a7-4b45-aec7-513f5ee62360' },
  { name: 'Miles College', franchiseId: '1e6702be-ee13-4727-88fa-2926ef772d0c' },
  { name: 'Morehouse College', franchiseId: '25144d79-3b6b-4349-8eb5-f851987ea28c' },
  { name: 'North Carolina A&T State University', franchiseId: '8a3ea2f8-1ee6-4d2a-9003-3a7d7e7e3e26' },
  { name: 'North Carolina Central University', franchiseId: '51c64b72-3800-44f8-9835-8b943b086ba8' },
  { name: 'Savannah State University', franchiseId: '57377050-6135-44fa-adc2-dd7f162e3e22' },
  { name: 'Shaw University', franchiseId: 'ef4a727a-1738-4058-ab4b-83db3e8a3117' },
  { name: 'South Carolina State University', franchiseId: 'b2446994-5a99-4058-b765-84b7ba6e0e55' },
  { name: 'Tennessee State University', franchiseId: '019cf601-c413-4c8a-bf86-eea825f100de' },
  { name: 'Texas College', franchiseId: 'e795af31-2cfb-44c0-898d-d00efd428ab9' },
  { name: 'Tuskegee University', franchiseId: '91bb85f2-f54f-4d51-b64b-8875aa26ed69' },
  { name: 'Virginia State University', franchiseId: '01f2a99c-757a-4e8d-b611-473ef0d147f4' },
  { name: 'Virginia Union University', franchiseId: '7cad82e1-82bb-4e38-be00-dc965dcd1b1e' },
  { name: 'Virginia University of Lynchburg', franchiseId: '1d319173-23e7-4061-90a2-bfb3c59f7dbc' },
  { name: 'West Virginia State University', franchiseId: 'd1d42d2f-42cc-43bb-a6a8-31824f17cfb0' },
  { name: 'Winston-Salem State University', franchiseId: '5bf1f48f-b4c8-4dc2-8e20-6549293b70cd' },
];

// ESPN's displayName doesn't always match our franchise name (abbreviations,
// "University" suffixes, ampersands). Add overrides here as mismatches surface
// in the `unresolved` output — this is intentionally sparse to start.
const NAME_OVERRIDES: Record<string, string> = {
  'North Carolina A&T State University': 'north carolina a&t aggies',
  'Lincoln University (MO)': 'lincoln (mo) blue tigers',
  'Lincoln University (PA)': 'lincoln (pa) lions',
};

interface EspnTeamListEntry {
  team: {
    id: string;
    displayName: string;
    location: string;
  };
}

interface EspnAthlete {
  id: string;
  fullName: string;
  jersey?: string;
  position?: { abbreviation?: string };
  weight?: number;
  displayHeight?: string;
  experience?: { displayValue?: string };
  birthPlace?: { city?: string; state?: string };
}

function getSupabase() {
  // Lazy init — module-scope createClient() breaks the Vercel build (see rise-os build fix notes)
  return createAdminClient();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'"]/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchEspnTeamList(): Promise<EspnTeamListEntry[]> {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=700';
  const res = await fetch(url, { headers: { 'User-Agent': 'rise-os-cron/1.0' } });
  if (!res.ok) throw new Error(`ESPN team list fetch failed: ${res.status}`);
  const data = await res.json();
  return data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
}

function resolveEspnId(
  schoolName: string,
  teamList: EspnTeamListEntry[]
): { id: string; matchedName: string } | null {
  const target = normalize(NAME_OVERRIDES[schoolName] ?? schoolName);

  for (const entry of teamList) {
    if (normalize(entry.team.displayName) === target) {
      return { id: entry.team.id, matchedName: entry.team.displayName };
    }
  }
  for (const entry of teamList) {
    const loc = normalize(entry.team.location);
    if (target.startsWith(loc) || loc.startsWith(target.split(' ')[0])) {
      return { id: entry.team.id, matchedName: entry.team.displayName };
    }
  }
  return null;
}

async function fetchRoster(espnId: string): Promise<EspnAthlete[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${espnId}?enable=roster`;
  const res = await fetch(url, { headers: { 'User-Agent': 'rise-os-cron/1.0' } });
  if (!res.ok) throw new Error(`ESPN roster fetch failed for team ${espnId}: ${res.status}`);
  const data = await res.json();
  return data?.team?.athletes ?? [];
}

function mapAthlete(a: EspnAthlete, schoolName: string, franchiseId: string, sourceUrl: string) {
  const hometown = a.birthPlace?.city
    ? [a.birthPlace.city, a.birthPlace.state].filter(Boolean).join(', ')
    : null;

  return {
    espn_athlete_id: Number(a.id),
    franchise_id: franchiseId,
    school_name: schoolName,
    name: a.fullName,
    position: a.position?.abbreviation ?? null,
    class_year: a.experience?.displayValue ?? null,
    height: a.displayHeight ?? null,
    weight: a.weight ?? null,
    hometown,
    jersey_number: a.jersey ? Number(a.jersey) : null,
    data_source: 'espn_api',
    source_url: sourceUrl,
    migrated: false,
  };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();
  const teamList = await fetchEspnTeamList();

  const resolved: { school: string; espnId: string; matchedName: string }[] = [];
  const unresolved: string[] = [];

  for (const school of HBCU_SCHOOLS) {
    const match = resolveEspnId(school.name, teamList);
    if (match) {
      resolved.push({ school: school.name, espnId: match.id, matchedName: match.matchedName });
    } else {
      unresolved.push(school.name);
    }
  }

  const results: { school: string; inserted: number; error?: string }[] = [];

  for (const { school, espnId } of resolved) {
    const franchiseId = HBCU_SCHOOLS.find((s) => s.name === school)!.franchiseId;
    const sourceUrl = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${espnId}?enable=roster`;

    try {
      const athletes = await fetchRoster(espnId);
      const rows = athletes.map((a) => mapAthlete(a, school, franchiseId, sourceUrl));

      if (rows.length > 0) {
        const { error } = await supabase
          .schema('rise_os')
          .from('hbcu_players')
          .upsert(rows, { onConflict: 'espn_athlete_id' });

        if (error) throw error;
      }

      results.push({ school, inserted: rows.length });
    } catch (err) {
      results.push({
        school,
        inserted: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return NextResponse.json({
    ranAt: new Date().toISOString(),
    resolvedCount: resolved.length,
    unresolved,
    results,
  });
}
