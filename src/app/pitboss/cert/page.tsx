'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'  // ← ADD THIS

// ... interfaces stay the same ...

export default function CertPage() {
  const router = useRouter()
  const { status } = useSession()             // ← ADD THIS
  const [leagues, setLeagues]       = useState<League[]>([])
  const [statuses, setStatuses]     = useState<Record<string, CertStatus>>({})
  const [starting, setStarting]     = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')  // ← ADD THIS
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return  // ← ADD THIS GUARD — this is the key fix
    
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const active = (data.leagues ?? data).filter(
          (l: League) => l.pitboss_status === 'active' || l.pitboss_status === 'trial'
        )
        setLeagues(active)
        return active
      })
      .then(async (active: League[]) => {
        const entries = await Promise.all(
          active.map(async (l: League) => {
            try {
              const r = await fetch(`/api/pitboss/cert/status?league_id=${l.id}`)
              const d = await r.json()
              if (!r.ok) return [l.id, { status: null, locked_until: null, certification_id: null }] as [string, CertStatus]  // ← ADD THIS — don't store error objects
              return [l.id, d] as [string, CertStatus]
            } catch {
              return [l.id, { status: null, locked_until: null, certification_id: null }] as [string, CertStatus]
            }
          })
        )
        setStatuses(Object.fromEntries(entries))
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])  // ← CHANGE [] to [status]

  // ... rest of component unchanged ...
