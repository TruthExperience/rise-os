// src/app/api/pitboss/steward/[id]/route.ts
//
// Retired. This was an older copy of the incident GET / analyse / resolve
// endpoints with NO steward or party check: any signed-in user could read any
// incident, run AI analysis on it, or resolve it and issue penalty points
// (with an arbitrary resolved_by). Nothing in the app calls it.
// The access-checked versions live in /api/pitboss/incidents/[id].

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const gone = () =>
  NextResponse.json(
    { error: 'This endpoint has been removed. Use /api/pitboss/incidents/[id].' },
    { status: 410 }
  )

export const GET = gone
export const POST = gone
export const PATCH = gone
export const PUT = gone
export const DELETE = gone
