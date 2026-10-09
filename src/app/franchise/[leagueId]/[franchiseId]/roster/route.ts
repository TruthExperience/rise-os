// GET /franchise/<leagueId>/<franchiseId>/roster
//
// Racing (PitBoss) team roster from driver_contracts. This used to be a
// second, cookie-scoped copy of the live endpoint at
// /api/pitboss/franchises/<leagueId>/<franchiseId>/roster. It now delegates
// to that handler, so there is one implementation and both URLs return the
// same data, including clean_race_streak, which only this copy used to
// select.
export const dynamic = 'force-dynamic'
export { GET } from '@/app/api/pitboss/franchises/[leagueId]/[franchiseId]/roster/route'
