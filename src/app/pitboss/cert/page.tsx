async function selectLeague(league: League) {
  setSelectedLeague(league)
  setRoles([])
  setError(null)
  setLoadingRoles(true)
  try {
    const [reqRes, statusRes] = await Promise.all([
      fetch(`/api/pitboss/cert/requirements?league_id=${league.id}`),
      fetch(`/api/pitboss/cert/status?league_id=${league.id}`),
    ])

    const reqData    = await reqRes.json()
    const statusData = await statusRes.json()

    if (!reqRes.ok) throw new Error(reqData.error ?? 'Failed to load roles')

    const requirements: RoleRequirement[] = reqData.requirements ?? []

    // Merge cert status into the matching role
    const enriched = requirements.map((role) => ({
      ...role,
      status:           statusData.status ?? 'eligible',
      attempt_number:   statusData.attempt_number ?? 0,
      locked_until:     statusData.locked_until ?? null,
      certification_id: statusData.certification_id ?? null,
    }))

    setRoles(enriched)
  } catch (e: any) {
    setError(e.message ?? 'Failed to load roles')
  } finally {
    setLoadingRoles(false)
  }
}
