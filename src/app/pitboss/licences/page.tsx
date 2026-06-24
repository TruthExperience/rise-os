import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

type Driver = {
  id: string
  discord_username: string
  display_name: string | null
  discord_avatar: string | null
  pp_total: number
  super_licence_status: 'active' | 'review' | 'suspended' | 'revoked'
}

type League = {
  id: string
  name: string
  slug: string
  sport: string
}

type Licence = {
  id: string
  licence_number: string
  role_code: string
  title: string
  tier: string | null
  era_endorsements: string[]
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  issued_at: string
  expires_at: string | null
  driver: Driver
  league: League
}

type Meta = { total: number; page: number; limit: number; pages: number }

// ─── Config ───────────────────────────────────────────────────────────────────

const STATUS = {
  active:    { label: 'Active',    color: '#30D158', cls: 'text-[#30D158] bg-[#30D158]/10 border-[#30D158]/25' },
  suspended: { label: 'Suspended', color: '#FF9F0A', cls: 'text-[#FF9F0A] bg-[#FF9F0A]/10 border-[#FF9F0A]/25' },
  revoked:   { label: 'Revoked',   color: '#FF3B30', cls: 'text-[#FF3B30] bg-[#FF3B30]/10 border-[#FF3B30]/25' },
  expired:   { label: 'Expired',   color: '#6B6B7A', cls: 'text-[#6B6B7A] bg-[#6B6B7A]/10 border-[#6B6B7A]/25' },
} as const

const TIER = {
  academy:  { label: 'Academy',  cls: 'text-[#6B6B7A] border-[#6B6B7A]/30' },
  apex:     { label: 'Apex',     cls: 'text-[#30D158] border-[#30D158]/30' },
  apex_pro: { label: 'Apex Pro', cls: 'text-[#FF9F0A] border-[#FF9F0A]/30' },
  elite:    { label: 'Elite',    cls: 'text-[#E8E020] border-[#E8E020]/30' },
} as const

const ROLE = {
  driver:       { label: 'Driver',       cls: 'text-[#60A5FA] border-[#60A5FA]/30' },
  reserve:      { label: 'Reserve',      cls: 'text-[#9090A0] border-[#9090A0]/30' },
  steward:      { label: 'Steward',      cls: 'text-[#FF9F0A] border-[#FF9F0A]/30' },
  commissioner: { label: 'Commissioner', cls: 'text-[#E8E020] border-[#E8E020]/30' },
} as const

const SUPER_STATUS_DOT: Record<string, string> = {
  review:    'bg-[#FF9F0A]',
  suspended: 'bg-[#FF3B30]',
  revoked:   'bg-[#FF3B30]',
}

const STATUS_FILTERS = [
  { value: '',          label: 'All' },
  { value: 'active',    label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'revoked',   label: 'Revoked' },
  { value: 'expired',   label: 'Expired' },
]

const ROLE_FILTERS = [
  { value: '',             label: 'All Roles' },
  { value: 'driver',       label: 'Driver' },
  { value: 'reserve',      label: 'Reserve' },
  { value: 'steward',      label: 'Steward' },
  { value: 'commissioner', label: 'Commissioner' },
]

const PAGE_LIMIT = 24

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Avatar({ driver }: { driver: Driver }) {
  const name = driver.display_name ?? driver.discord_username
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  if (driver.discord_avatar) {
    return (
      <img
        src={driver.discord_avatar}
        alt={initials}
        className="w-9 h-9 rounded-full object-cover bg-[#2A2A35] shrink-0"
      />
    )
  }

  return (
    <div className="w-9 h-9 rounded-full bg-[#2A2A35] flex items-center justify-center shrink-0">
      <span className="font-mono text-xs font-bold text-[#6B6B7A]">{initials}</span>
    </div>
  )
}

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${cls}`}>
      {children}
    </span>
  )
}

function PillFilter({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`font-mono text-[10px] px-3 py-1.5 rounded-lg uppercase tracking-wider transition-colors duration-100 ${
            value === o.value
              ? 'bg-[#E8E020] text-[#0A0A0F] font-bold'
              : 'bg-[#1A1A24] text-[#6B6B7A] border border-[#2A2A35] hover:border-[#3A3A48] hover:text-[#F0F0F0]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="bg-[#13131A] border border-[#2A2A35] border-l-2 rounded-xl p-4 space-y-4 animate-pulse"
      style={{ borderLeftColor: '#2A2A35' }}>
      <div className="flex justify-between items-start">
        <div className="h-4 w-24 bg-[#2A2A35] rounded" />
        <div className="h-5 w-16 bg-[#2A2A35] rounded-full" />
      </div>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-[#2A2A35]" />
        <div className="space-y-1.5 flex-1">
          <div className="h-3 w-32 bg-[#2A2A35] rounded" />
          <div className="h-2.5 w-20 bg-[#2A2A35] rounded" />
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="h-4 w-14 bg-[#2A2A35] rounded" />
        <div className="h-4 w-12 bg-[#2A2A35] rounded" />
      </div>
      <div className="h-2.5 w-28 bg-[#2A2A35] rounded" />
    </div>
  )
}

function LicenceCard({ licence }: { licence: Licence }) {
  const status = STATUS[licence.status] ?? STATUS.expired
  const role   = ROLE[licence.role_code as keyof typeof ROLE]
  const tier   = licence.tier ? TIER[licence.tier as keyof typeof TIER] : null
  const driver = licence.driver
  const driverName = driver.display_name ?? driver.discord_username
  const superDot = SUPER_STATUS_DOT[driver.super_licence_status]

  return (
    <Link href={`/pitboss/licences/${licence.id}`}>
      <div
        className="bg-[#13131A] border border-[#2A2A35] border-l-2 rounded-xl p-4 space-y-4
                   hover:border-[#3A3A48] hover:bg-[#15151E] transition-all duration-150 cursor-pointer h-full"
        style={{ borderLeftColor: status.color }}
      >
        {/* Top row: number + status */}
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-sm font-bold text-[#F0F0F0] tracking-wider">
            {licence.licence_number}
          </p>
          <span className={`font-mono text-[9px] px-2 py-1 rounded-full border uppercase tracking-wider shrink-0 ${status.cls}`}>
            {status.label}
          </span>
        </div>

        {/* Driver */}
        <div className="flex items-center gap-3">
          <Avatar driver={driver} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-[#F0F0F0] truncate">{driverName}</p>
              {superDot && (
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${superDot}`} title={`Super licence: ${driver.super_licence_status}`} />
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="font-mono text-[10px] text-[#6B6B7A] truncate">
                @{driver.discord_username}
              </p>
              {driver.pp_total > 0 && (
                <span className="font-mono text-[9px] text-[#FF9F0A]">
                  {driver.pp_total} PP
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {role && <Badge cls={role.cls}>{role.label}</Badge>}
          {tier && <Badge cls={tier.cls}>{tier.label}</Badge>}
          {licence.era_endorsements?.slice(0, 2).map((era) => (
            <Badge key={era} cls="text-[#6B6B7A] border-[#2A2A35]">{era}</Badge>
          ))}
          {(licence.era_endorsements?.length ?? 0) > 2 && (
            <span className="font-mono text-[9px] text-[#6B6B7A]">
              +{licence.era_endorsements.length - 2}
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-end justify-between pt-1 border-t border-[#2A2A35]">
          <div>
            <p className="font-mono text-[9px] text-[#6B6B7A] uppercase tracking-wider">
              {licence.league.name}
            </p>
            <p className="font-mono text-[9px] text-[#4A4A58] mt-0.5">
              Issued {formatDate(licence.issued_at)}
            </p>
          </div>
          {licence.expires_at && (
            <p className="font-mono text-[9px] text-[#4A4A58]">
              Exp {formatDate(licence.expires_at)}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center py-24 text-center space-y-4">
      <p className="text-4xl">🪪</p>
      <div>
        <p className="text-[#F0F0F0] font-medium">
          {filtered ? 'No licences match your filters' : 'No licences issued yet'}
        </p>
        <p className="text-sm text-[#6B6B7A] mt-1">
          {filtered
            ? 'Try adjusting your search or filters.'
            : 'Issue the first licence to get started.'}
        </p>
      </div>
      {filtered ? (
        <button
          onClick={onClear}
          className="font-mono text-xs px-4 py-2 rounded-lg border border-[#2A2A35] text-[#6B6B7A] hover:border-[#3A3A48] hover:text-[#F0F0F0] transition-colors"
        >
          Clear filters
        </button>
      ) : (
        <Link
          href="/pitboss/licences/new"
          className="font-mono text-xs px-4 py-2 rounded-lg bg-[#E8E020] text-[#0A0A0F] font-bold hover:bg-[#F5F030] transition-colors"
        >
          Issue First Licence
        </Link>
      )}
    </div>
  )
}

function Pagination({
  meta,
  onPage,
}: {
  meta: Meta
  onPage: (p: number) => void
}) {
  if (meta.pages <= 1) return null

  const pages = Array.from({ length: meta.pages }, (_, i) => i + 1)
  // Show max 7 page numbers: first, last, current ±2, with ellipsis
  const visible = pages.filter(
    (p) => p === 1 || p === meta.pages || Math.abs(p - meta.page) <= 1
  )

  return (
    <div className="flex items-center justify-between pt-6 border-t border-[#2A2A35]">
      <p className="font-mono text-[10px] text-[#6B6B7A] uppercase tracking-wider">
        {meta.total} licence{meta.total !== 1 ? 's' : ''} · page {meta.page} of {meta.pages}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(meta.page - 1)}
          disabled={meta.page === 1}
          className="font-mono text-xs px-3 py-1.5 rounded-lg border border-[#2A2A35] text-[#6B6B7A]
                     disabled:opacity-30 disabled:cursor-not-allowed
                     hover:border-[#3A3A48] hover:text-[#F0F0F0] transition-colors"
        >
          ←
        </button>

        {visible.map((p, i) => {
          const prev = visible[i - 1]
          const gap = prev && p - prev > 1
          return (
            <span key={p} className="flex items-center gap-1">
              {gap && <span className="font-mono text-xs text-[#3A3A48] px-1">…</span>}
              <button
                onClick={() => onPage(p)}
                className={`font-mono text-xs w-8 h-8 rounded-lg border transition-colors ${
                  p === meta.page
                    ? 'bg-[#E8E020] border-[#E8E020] text-[#0A0A0F] font-bold'
                    : 'border-[#2A2A35] text-[#6B6B7A] hover:border-[#3A3A48] hover:text-[#F0F0F0]'
                }`}
              >
                {p}
              </button>
            </span>
          )
        })}

        <button
          onClick={() => onPage(meta.page + 1)}
          disabled={meta.page === meta.pages}
          className="font-mono text-xs px-3 py-1.5 rounded-lg border border-[#2A2A35] text-[#6B6B7A]
                     disabled:opacity-30 disabled:cursor-not-allowed
                     hover:border-[#3A3A48] hover:text-[#F0F0F0] transition-colors"
        >
          →
        </button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LicencesPage() {
  const [licences, setLicences]   = useState<Licence[]>([])
  const [meta, setMeta]           = useState<Meta | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [roleFilter, setRoleFilter]     = useState('')
  const [search, setSearch]             = useState('')
  const [page, setPage]                 = useState(1)

  // Fetch when API-level filters or page change
  useEffect(() => {
    setLoading(true)
    setError(null)

    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) })
    if (statusFilter) params.set('status', statusFilter)
    if (roleFilter)   params.set('role_code', roleFilter)

    fetch(`/api/pitboss/licences?${params}`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load licences')
        setLicences(data.data ?? [])
        setMeta(data.meta)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [statusFilter, roleFilter, page])

  // Reset to page 1 when filters change
  const handleStatusFilter = (v: string) => { setStatusFilter(v); setPage(1) }
  const handleRoleFilter   = (v: string) => { setRoleFilter(v);   setPage(1) }
  const handleClear        = ()          => { setStatusFilter(''); setRoleFilter(''); setSearch(''); setPage(1) }

  // Client-side search on top of fetched results
  const filtered = useMemo(() => {
    if (!search.trim()) return licences
    const q = search.toLowerCase()
    return licences.filter(
      (l) =>
        l.licence_number.toLowerCase().includes(q) ||
        (l.driver.display_name ?? '').toLowerCase().includes(q) ||
        l.driver.discord_username.toLowerCase().includes(q) ||
        l.league.name.toLowerCase().includes(q),
    )
  }, [licences, search])

  const isFiltered = !!(statusFilter || roleFilter || search.trim())

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-[#F0F0F0]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] tracking-[0.2em] text-[#6B6B7A] uppercase mb-1">
              Pitboss
            </p>
            <h1 className="text-2xl font-semibold text-[#F0F0F0]">Licences</h1>
            {meta && !loading && (
              <p className="font-mono text-xs text-[#6B6B7A] mt-1">
                {meta.total} total
              </p>
            )}
          </div>
          <Link
            href="/pitboss/licences/new"
            className="shrink-0 font-mono text-xs px-4 py-2.5 bg-[#E8E020] text-[#0A0A0F] font-bold rounded-xl
                       hover:bg-[#F5F030] active:scale-95 transition-all duration-100 tracking-wide"
          >
            + Issue Licence
          </Link>
        </div>

        {/* Filters */}
        <div className="space-y-3">
          <PillFilter options={STATUS_FILTERS} value={statusFilter} onChange={handleStatusFilter} />
          <PillFilter options={ROLE_FILTERS}   value={roleFilter}   onChange={handleRoleFilter} />
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search licence #, driver, or league…"
              className="w-full sm:w-80 bg-[#13131A] border border-[#2A2A35] rounded-xl px-4 py-2.5
                         font-mono text-xs text-[#F0F0F0] placeholder-[#4A4A58]
                         focus:outline-none focus:border-[#3A3A48]
                         transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B6B7A] hover:text-[#F0F0F0] font-mono text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-[#FF3B30]/10 border border-[#FF3B30]/20 rounded-xl px-4 py-3">
            <p className="font-mono text-xs text-[#FF3B30]">{error}</p>
          </div>
        )}

        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {loading
            ? Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)
            : filtered.length > 0
            ? filtered.map((l) => <LicenceCard key={l.id} licence={l} />)
            : <EmptyState filtered={isFiltered} onClear={handleClear} />
          }
        </div>

        {/* Pagination */}
        {!loading && meta && (
          <Pagination meta={meta} onPage={setPage} />
        )}
      </div>
    </div>
  )
}
