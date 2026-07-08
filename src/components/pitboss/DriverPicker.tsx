'use client'

import { useEffect, useRef, useState } from 'react'

export interface DriverOption {
  id: string
  discord_username: string
  display_name: string | null
  discord_avatar: string | null
  team: string | null
  car_number: string | null
  role_primary: string | null
}

// ─── Driver Picker ────────────────────────────────────────────────────────────
// Search-as-you-type selector backed by /api/pitboss/leagues/[id]/drivers,
// which is sourced from the AWC credential registry. Shared by the steward
// "Open New Ticket" form and the driver-facing "Report Incident" form so
// both surfaces resolve accused/reported drivers the same way.
export function DriverPicker({
  leagueId,
  label,
  value,
  onChange,
  placeholder,
}: {
  leagueId: string
  label: string
  value: DriverOption | null
  onChange: (driver: DriverOption | null) => void
  placeholder: string
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DriverOption[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(query), 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, open])

  async function search(q: string) {
    setLoading(true)
    try {
      const url = `/api/pitboss/leagues/${leagueId}/drivers${q ? `?search=${encodeURIComponent(q)}` : ''}`
      const res = await fetch(url)
      const data = await res.json()
      setResults(data.drivers ?? [])
    } finally {
      setLoading(false)
    }
  }

  function select(driver: DriverOption) {
    onChange(driver)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative">
      <p className="text-white/40 text-xs uppercase tracking-widest mb-2">{label}</p>

      {value ? (
        <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            {value.discord_avatar ? (
              <img
                src={`https://cdn.discordapp.com/avatars/${value.id}/${value.discord_avatar}.png?size=32`}
                alt=""
                className="w-7 h-7 rounded-lg object-cover"
              />
            ) : (
              <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center text-white text-xs font-bold">
                {(value.display_name ?? value.discord_username)[0]?.toUpperCase()}
              </div>
            )}
            <div>
              <p className="text-white text-sm font-semibold">
                {value.display_name ?? value.discord_username}
              </p>
              {value.team && <p className="text-white/30 text-[10px]">{value.team}</p>}
            </div>
          </div>
          <button onClick={() => onChange(null)} className="text-white/30 text-xs">✕</button>
        </div>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => { setOpen(true); search(query) }}
            placeholder={placeholder}
            className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
          />
          {open && (
            <div className="absolute z-10 mt-2 w-full max-h-64 overflow-y-auto bg-[#1A1A1A] border border-white/10 rounded-xl shadow-xl">
              {loading ? (
                <p className="text-white/30 text-xs px-4 py-3">Searching…</p>
              ) : results.length === 0 ? (
                <p className="text-white/30 text-xs px-4 py-3">No drivers found.</p>
              ) : (
                results.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => select(d)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5"
                  >
                    {d.discord_avatar ? (
                      <img
                        src={`https://cdn.discordapp.com/avatars/${d.id}/${d.discord_avatar}.png?size=32`}
                        alt=""
                        className="w-7 h-7 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center text-white text-xs font-bold">
                        {(d.display_name ?? d.discord_username)[0]?.toUpperCase()}
                      </div>
                    )}
                    <div>
                      <p className="text-white text-sm">{d.display_name ?? d.discord_username}</p>
                      {d.team && <p className="text-white/30 text-[10px]">{d.team}</p>}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
