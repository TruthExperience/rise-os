// src/app/api/pitboss/guild-joined/route.ts
//
// POST /api/pitboss/guild-joined   (called by pitboss-guardian on GUILD_CREATE)
//   Header: x-guild-sync-key: <GUILD_SYNC_SECRET>
//   Body:   { guild: { id, name, owner_id, roles: [...], channels: [...] } }
//
// Runs the automatic league setup for the server the bot just joined.

import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import { autoProvisionGuild, GuildSnapshot } from '@/lib/pitboss/autoProvisionGuild'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function safeEqual(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export async function POST(req: NextRequest) {
  const secret = process.env.GUILD_SYNC_SECRET
  if (!secret) return NextResponse.json({ error: 'GUILD_SYNC_SECRET not set' }, { status: 500 })

  const provided = req.headers.get('x-guild-sync-key') ?? ''
  if (!provided || !safeEqual(provided, secret)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let body: { guild?: GuildSnapshot }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const guild = body.guild
  if (!guild?.id || !/^\d{15,25}$/.test(guild.id)) {
    return NextResponse.json({ error: 'guild.id is required' }, { status: 400 })
  }

  const result = await autoProvisionGuild({ guildId: guild.id, snapshot: guild })
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
