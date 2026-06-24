import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LicenceCardDriver {
  id: string
  discord_username: string
  display_name: string | null
  discord_avatar: string | null
  tier: string
  pp_total: number
  super_licence_status: string
}

export interface LicenceCardLeague {
  id: string
  name: string
  slug: string
}

export interface LicenceCardData {
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
  driver: LicenceCardDriver
  league: LicenceCardLeague
}

interface LicenceCardProps {
  licence: LicenceCardData
  /** Show the driver avatar + name header. Default true. */
  showDriver?: boolean
  /** Show the league name. Default true. */
  showLeague?: boolean
  /** Render as a clickable link to the licence detail page. Default true. */
  linkable?: boolean
  /** Extra class names on the outer wrapper. */
  className?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  driver: 'Driver', reserve: 'Reserve', steward: 'Steward', commissioner: 'Commissioner',
}

const TIER_LABELS: Record<string, string> = {
  academy: 'Academy', apex: 'Apex', apex_pro: 'Apex Pro', elite: 'Elite',
}

const STATUS_CONFIG: Record<string, { stripe: string; badge: string; dot: string; label: string }> = {
  active:    { stripe: 'bg-green-500',  badge: 'bg-green-100 text-green-800',   dot: 'bg-green-500',  label: 'Active' },
  suspended: { stripe: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-800', dot: 'bg-yellow-400', label: 'Suspended' },
  revoked:   { stripe: 'bg-red-500',    badge: 'bg-red-100 text-red-800',       dot: 'bg-red-500',    label: 'Revoked' },
  expired:   { stripe: 'bg-gray-400',   badge: 'bg-gray-100 text-gray-600',     dot: 'bg-gray-400',   label: 'Expired' },
}

const ROLE_STRIPE: Record<string, string> = {
  driver:       'from-blue-600 to-blue-800',
  reserve:      'from-indigo-500 to-indigo-700',
  steward:      'from-violet-600 to-violet-800',
  commissioner: 'from-gray-700 to-gray-900',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function isExpiringSoon(expires_at: string | null): boolean {
  if (!expires_at) return false
  const days = (new Date(expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  return days >= 0 && days <= 30
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LicenceCard({
  licence,
  showDriver = true,
  showLeague = true,
  linkable = true,
  className = '',
}: LicenceCardProps) {
  const status   = STATUS_CONFIG[licence.status] ?? STATUS_CONFIG.expired
  const stripe   = ROLE_STRIPE[licence.role_code] ?? 'from-gray-600 to-gray-800'
  const expiring = licence.status === 'active' && isExpiringSoon(licence.expires_at)

  const card = (
    <div className={`
      group relative flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm
      overflow-hidden transition-shadow duration-200
      ${linkable ? 'hover:shadow-md cursor-pointer' : ''}
      ${className}
    `}>
      {/* Role stripe header */}
      <div className={`h-1.5 w-full bg-gradient-to-r ${stripe}`} />

      {/* Status stripe (right edge) */}
      <div className={`absolute top-1.5 right-0 bottom-0 w-1 ${status.stripe}`} />

      <div className="p-4 flex flex-col gap-3">

        {/* Driver header */}
        {showDriver && (
          <div className="flex items-center gap-3 pr-2">
            {licence.photo_url || licence.driver.discord_avatar ? (
              <img
                src={licence.photo_url ?? licence.driver.discord_avatar!}
                alt={licence.driver.display_name ?? licence.driver.discord_username}
                className="h-10 w-10 rounded-full object-cover ring-2 ring-gray-100 shrink-0"
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-gray-200 flex items-center justify-center text-sm font-bold text-gray-500 shrink-0">
                {(licence.driver.display_name ?? licence.driver.discord_username).charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">
                {licence.driver.display_name ?? licence.driver.discord_username}
              </p>
              <p className="text-xs text-gray-400 truncate">@{licence.driver.discord_username}</p>
            </div>
          </div>
        )}

        {/* Licence number + status */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-sm font-bold text-gray-800 tracking-wide">
            {licence.licence_number}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${status.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
        </div>

        {/* Role + title */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            {ROLE_LABELS[licence.role_code] ?? licence.role_code}
          </p>
          <p className="text-sm text-gray-800 mt-0.5 leading-snug">{licence.title}</p>
        </div>

        {/* Tier + League + PP */}
        <div className="flex items-center gap-2 flex-wrap">
          {licence.tier && (
            <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
              {TIER_LABELS[licence.tier] ?? licence.tier}
            </span>
          )}
          {showLeague && (
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {licence.league.name}
            </span>
          )}
          {licence.driver.pp_total > 0 && (
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${
              licence.driver.pp_total >= 10 ? 'bg-red-50 text-red-700' : 'bg-orange-50 text-orange-700'
            }`}>
              {licence.driver.pp_total} PP
            </span>
          )}
        </div>

        {/* Era endorsements */}
        {licence.era_endorsements.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {licence.era_endorsements.map(e => (
              <span key={e} className="rounded bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">{e}</span>
            ))}
          </div>
        )}

        {/* Footer: dates */}
        <div className="border-t border-gray-100 pt-2 flex items-center justify-between text-xs text-gray-400">
          <span>Issued {fmt(licence.issued_at)}</span>
          {licence.expires_at ? (
            <span className={expiring ? 'text-orange-500 font-medium' : ''}>
              {expiring ? '⚠ ' : ''}Exp {fmt(licence.expires_at)}
            </span>
          ) : (
            <span>No expiry</span>
          )}
        </div>

      </div>
    </div>
  )

  if (!linkable) return card

  return (
    <Link href={`/pitboss/licences/${licence.id}`} className="block">
      {card}
    </Link>
  )
}

export default LicenceCard
