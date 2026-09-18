import crypto from 'crypto'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_URL     = 'https://oauth2.googleapis.com/token'

function base64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

async function getAccessToken(): Promise<string | null> {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL
  const privateKey  = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!clientEmail || !privateKey) {
    console.error('[sheets-sync] missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY')
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss:   clientEmail,
    scope: SHEETS_SCOPE,
    aud:   TOKEN_URL,
    iat:   now,
    exp:   now + 3600,
  }

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const signature = base64url(signer.sign(privateKey))
  const assertion = `${unsigned}.${signature}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!res.ok) {
    console.error('[sheets-sync] token exchange failed', await res.text())
    return null
  }

  const data = await res.json() as { access_token?: string }
  return data.access_token ?? null
}

async function appendRow(sheetId: string, values: (string | number)[]) {
  const accessToken = await getAccessToken()
  if (!accessToken) return

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:E:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ values: [values] }),
    }
  )

  if (!res.ok) {
    console.error('[sheets-sync] append failed', await res.text())
  }
}

// Maps a specific (league_id, role_code) pair to the Sheet it syncs scores
// to. Add another entry here whenever a new league/role gets its own
// tracking sheet — everything else in this file stays generic.
const SHEET_TARGETS: Record<string, string | undefined> = {
  '992e968c-c0e5-4aea-9fb2-bc19c3468fc6:JURY': process.env.GOOGLE_SHEETS_EFRL_JURY_ID, // EFRL
}

export async function syncCertScoreToSheet(params: {
  leagueId:    string
  roleCode:    string
  driverName:  string
  score:       number
  passMark:    number
  passed:      boolean
  completedAt: string
}) {
  const sheetId = SHEET_TARGETS[`${params.leagueId}:${params.roleCode}`]
  if (!sheetId) return // no sheet configured for this league/role — no-op

  await appendRow(sheetId, [
    params.completedAt,
    params.driverName,
    params.score,
    params.passMark,
    params.passed ? 'PASSED' : 'FAILED',
  ])
}
