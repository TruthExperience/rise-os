import { NextResponse } from 'next/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'

export const dynamic = 'force-dynamic'

// This endpoint used to return whether any answer to any question was
// correct, with no login. That let anyone work out the answer key one
// guess at a time. Answers are now graded on the server when they are
// saved (PATCH /api/exam-session/progress), so nothing here needs to
// reveal correctness. It stays so the exam page's existing call doesn't
// break. Remove it, and the call in exam/page.tsx, together.
export async function GET() {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ is_correct: null })
}
