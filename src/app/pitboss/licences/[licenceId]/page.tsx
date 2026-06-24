'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

interface Driver {
  id: string
  discord_username: string
  display_name: string | null
  discord_avatar: string | null
  tier: string
  pp_total: number
  super_licence_status: string
}

interface League {
  id: string
  name: string
  slug: string
}

interface Licence {
  id: string
  licence_number: string
  role_code: string
  title: string
  tier: string | null
  era_endorsements: string[]
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  issued_at: string
  expires_at: string | null
  photo_url: string | null
  qr_token: string
  created_at: string
  updated_at: string
  driver: Driver
  league: League
}

const ROLE_LABELS: Record<string, string> = {
  driver: 'Driver', reserve: 'Reserve', steward: 'Steward', commissioner: 'Commissioner',
}

const TIER_LABELS: Record<string, string> = {
  academy: 'Academy', apex: 'Apex', apex_pro: 'Apex Pro', elite: 'Elite',
}

const STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
  active:    { badge: 'bg-green-100 text-green-800',   dot: 'bg-green-500' },
  suspended: { badge: 'bg-yellow-100 text-yellow-800', dot: 'bg-yellow-500' },
  revoked:   { badge: 'bg-red-100 text-red-800',       dot: 'bg-red-500' },
  expired:   { badge: 'bg-gray-100 text-gray-600',     dot: 'bg-gray-400' },
}

const SUPER_LICENCE_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800', review: 'bg-yellow-100 text-yellow-800',
  suspended: 'bg-orange-100 text-orange-800', revoked: 'bg-red-100 text-red-800',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{children}</dd>
    </div>
  )
}

function StatusActions({ licence, onStatusChange, updating }: {
  licence: Licence
  onStatusChange: (status: string) => void
  updating: boolean
}) {
  const actions: { label: string; target: string; style: string }[] = []
  if (licence.status === 'active') {
    actions.push(
      { label: 'Suspend',  target: 'suspended', style: 'bg-yellow-50 text-yellow-700 border-yellow-300 hover:bg-yellow-100' },
      { label: 'Revoke',   target: 'revoked',   style: 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100' },
    )
  }
  if (licence.status === 'suspended') {
    actions.push(
      { label: 'Reinstate', target: 'active',  style: 'bg-green-50 text-green-700 border-green-300 hover:bg-green-100' },
      { label: 'Revoke',    target: 'revoked', style: 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100' },
    )
  }
  if (licence.status === 'revoked' || licence.status === 'expired') {
    actions.push({ label: 'Reinstate', target: 'active', style: 'bg-green-50 text-green-700 border-green-300 hover:bg-green-100' })
  }
  if (actions.length === 0) return null
  return (
    <div className="flex gap-2">
      {actions.map(a => (
        <button key={a.target} onClick={() => onStatusChange(a.target)} disabled={updating}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${a.style}`}>
          {updating ? '…' : a.label}
        </button>
      ))}
    </div>
  )
}

export default function LicenceDetailPage() {
  const { licenceId } = useParams<{ licenceId: string }>()
  const router = useRouter()
  const [licence, setLicence]   = useState<Licence | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [toast, setToast]       = useState<{ msg: string; ok: boolean } | null>(null)

  useEffect(() => {
    if (!licenceId) return
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/pitboss/licences/${licenceId}`)
        if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error ?? `HTTP ${res.status}`) }
        const json = await res.json()
        if (!cancelled) setLicence(json.data)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [licenceId])

  async function handleStatusChange(newStatus: string) {
    if (!licence) return
    setUpdating(true)
    try {
      const res = await fetch(`/api/pitboss/licences/${licenceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error ?? `HTTP ${res.status}`) }
      const json = await res.json()
      setLicence(json.data)
      showToast(`Licence ${newStatus}`, true)
    } catch (err) {
      showToast((err as Error).message, false)
    } finally {
      setUpdating(false)
    }
  }

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-[300px] text-gray-400 text-sm">Loading licence…</div>
  )

  if (error || !licence) return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error ?? 'Licence not found.'}</div>
      <button onClick={() => router.back()} className="mt-4 text-sm text-blue-600 hover:underline">← Back</button>
    </div>
  )

  const statusStyle = STATUS_STYLES[licence.status] ?? STATUS_STYLES.expired
  const verifyUrl   = `/verify/${licence.qr_token}`

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 rounded-md px-4 py-2.5 text-sm font-medium shadow-lg ${toast.ok ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.msg}
        </div>
      )}

      <nav className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/pitboss/licences" className="hover:text-gray-900">Licences</Link>
        <span>/</span>
        <span className="font-mono text-gray-900">{licence.licence_number}</span>
      </nav>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-start gap-4 p-6">
          <div className="shrink-0">
            {licence.driver.discord_avatar ? (
              <img src={licence.photo_url ?? licence.driver.discord_avatar} alt={licence.driver.display_name ?? licence.driver.discord_username}
                className="h-16 w-16 rounded-full object-cover ring-2 ring-gray-200" />
            ) : (
              <div className="h-16 w-16 rounded-full bg-gray-200 flex items-center justify-center text-xl font-bold text-gray-500">
                {(licence.driver.display_name ?? licence.driver.discord_username).charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900 truncate">{licence.driver.display_name ?? licence.driver.discord_username}</h1>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.badge}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                {licence.status.charAt(0).toUpperCase() + licence.status.slice(1)}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">@{licence.driver.discord_username}</p>
            <p className="font-mono text-sm font-semibold text-gray-700 mt-1">{licence.licence_number}</p>
          </div>
          <StatusActions licence={licence} onStatusChange={handleStatusChange} updating={updating} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Licence Details</h2>
          <dl className="space-y-3">
            <Field label="Title">{licence.title}</Field>
            <Field label="Role">{ROLE_LABELS[licence.role_code] ?? licence.role_code}</Field>
            {licence.tier && <Field label="Tier">{TIER_LABELS[licence.tier] ?? licence.tier}</Field>}
            <Field label="League">
              <Link href={`/pitboss/leagues/${licence.league.id}`} className="text-blue-600 hover:underline">{licence.league.name}</Link>
            </Field>
            <Field label="Issued">{fmt(licence.issued_at)}</Field>
            <Field label="Expires">{licence.expires_at ? fmt(licence.expires_at) : <span className="text-gray-400">No expiry</span>}</Field>
            {licence.era_endorsements.length > 0 && (
              <Field label="Era Endorsements">
                <div className="flex flex-wrap gap-1 mt-1">
                  {licence.era_endorsements.map(e => (
                    <span key={e} className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{e}</span>
                  ))}
                </div>
              </Field>
            )}
          </dl>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Driver Details</h2>
          <dl className="space-y-3">
            <Field label="Tier">{TIER_LABELS[licence.driver.tier] ?? licence.driver.tier}</Field>
            <Field label="Penalty Points">{licence.driver.pp_total} PP</Field>
            <Field label="Super Licence">
              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${SUPER_LICENCE_STYLES[licence.driver.super_licence_status] ?? ''}`}>
                {licence.driver.super_licence_status}
              </span>
            </Field>
          </dl>
          <div className="pt-2 border-t border-gray-100">
            <Link href={`/pitboss/drivers/${licence.driver.id}`} className="text-sm text-blue-600 hover:underline">View driver profile →</Link>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Verification</h2>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 mb-1">Public verification URL</p>
            <a href={verifyUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-600 hover:underline break-all">
              {typeof window !== 'undefined' ? `${window.location.origin}${verifyUrl}` : verifyUrl}
            </a>
          </div>
          <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}${verifyUrl}`).then(() => showToast('Copied!', true)) }}
            className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            Copy link
          </button>
        </div>
      </div>

      <div className="text-xs text-gray-400 flex gap-4">
        <span>Created {fmtTime(licence.created_at)}</span>
        <span>·</span>
        <span>Updated {fmtTime(licence.updated_at)}</span>
      </div>
    </div>
  )
}
