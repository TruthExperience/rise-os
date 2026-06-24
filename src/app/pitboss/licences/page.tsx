'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

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
  driver: Driver
  league: League
}

interface Meta {
  total: number
  page: number
  limit: number
  pages: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  driver:       'Driver',
  reserve:      'Reserve',
  steward:      'Steward',
  commissioner: 'Commissioner',
}

const STATUS_COLOURS: Record<string, string> = {
  active:    'bg-green-100 text-green-800',
  suspended: 'bg-yellow-100 text-yellow-800',
  revoked:   'bg-red-100 text-red-800',
  expired:   'bg-gray-100 text-gray-600',
}

const PAGE_SIZE = 20

// ─── Component ───────────────────────────────────────────────────────────────

export default function LicencesPage() {
  const [licences, setLicences]   = useState<Licence[]>([])
  const [meta, setMeta]           = useState<Meta | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  const [search, setSearch]       = useState('')
  const [roleFilter, setRole]     = useState('')
  const [statusFilter, setStatus] = useState('')
  const [page, setPage]           = useState(1)

  useEffect(() => {
    const controller = new AbortController()

    async function fetchLicences() {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams({
        page:  String(page),
        limit: String(PAGE_SIZE),
      })
      if (roleFilter)   params.set('role_code', roleFilter)
      if (statusFilter) params.set('status', statusFilter)

      try {
        const res = await fetch(`/api/pitboss/licences?${params}`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        const json = await res.json()
        setLicences(json.data ?? [])
        setMeta(json.meta ?? null)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchLicences()
    return () => controller.abort()
  }, [page, roleFilter, statusFilter])

  useEffect(() => { setPage(1) }, [roleFilter, statusFilter])

  const filtered = useMemo(() => {
    if (!search.trim()) return licences
    const q = search.toLowerCase()
    return licences.filter(l =>
      l.licence_number.toLowerCase().includes(q) ||
      (l.driver.display_name ?? l.driver.discord_username).toLowerCase().includes(q) ||
      l.driver.discord_username.toLowerCase().includes(q) ||
      l.title.toLowerCase().includes(q)
    )
  }, [licences, search])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Licences</h1>
          {meta && (
            <p className="text-sm text-gray-500 mt-0.5">
              {meta.total.toLocaleString()} licence{meta.total !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <Link
          href="/pitboss/licences/issue"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          Issue Licence
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="search"
          placeholder="Search by name or licence number…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={roleFilter}
          onChange={e => setRole(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All roles</option>
          {Object.entries(ROLE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="revoked">Revoked</option>
          <option value="expired">Expired</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Licence #', 'Driver', 'League', 'Role', 'Title', 'Status', 'Issued', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">Loading…</td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">No licences found.</td>
              </tr>
            ) : (
              filtered.map(licence => (
                <tr key={licence.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono font-medium text-gray-900 whitespace-nowrap">
                    {licence.licence_number}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link href={`/pitboss/drivers/${licence.driver.id}`} className="font-medium text-blue-600 hover:underline">
                      {licence.driver.display_name ?? licence.driver.discord_username}
                    </Link>
                    <div className="text-xs text-gray-400">{licence.driver.discord_username}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">{licence.league.name}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">
                    {ROLE_LABELS[licence.role_code] ?? licence.role_code}
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate">{licence.title}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_COLOURS[licence.status] ?? ''}`}>
                      {licence.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-500">
                    {new Date(licence.issued_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right">
                    <Link href={`/pitboss/licences/${licence.id}`} className="text-xs text-blue-600 hover:underline">
                      View →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {meta && meta.pages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-500">Page {meta.page} of {meta.pages}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(meta.pages, p + 1))}
              disabled={page >= meta.pages}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
