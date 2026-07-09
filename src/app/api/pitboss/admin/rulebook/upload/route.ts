'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface League {
  id: string
  name: string
  slug: string
}

interface RoleRequirement {
  role_code: string
  role_name: string
  question_count: number
}

interface UploadResult {
  role_code: string
  target_count: number
  questions_generated: number
  questions_inserted: number
}

export default function RulebookAdminPage() {
  const router          = useRouter()
  const { status }      = useSession()
  const fileRef         = useRef<HTMLInputElement>(null)

  const [leagues, setLeagues]     = useState<League[]>([])
  const [leagueId, setLeagueId]   = useState('')
  const [roles, setRoles]         = useState<RoleRequirement[]>([])
  const [roleCode, setRoleCode]   = useState('')
  const [version, setVersion]     = useState('')
  const [file, setFile]           = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult]       = useState<UploadResult | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : data.leagues ?? []
        setLeagues(list.filter((l: any) => l.pitboss_status === 'active' || l.pitboss_status === 'trial'))
        if (list.length > 0) setLeagueId(list[0].id)
      })
      .finally(() => setLoading(false))
  }, [status])

  useEffect(() => {
    if (!leagueId) {
      setRoles([])
      setRoleCode('')
      return
    }
    fetch(`/api/pitboss/role-requirements?league_id=${leagueId}`)
      .then((r) => r.json())
      .then((data) => {
        const list: RoleRequirement[] = data.data ?? []
        setRoles(list)
        setRoleCode(list.length > 0 ? list[0].role_code : '')
      })
  }, [leagueId])

  async function handleUpload() {
    if (!file || !leagueId || !roleCode || !version.trim()) {
      setError('Please select a league, a role, enter a version, and choose a file.')
      return
    }

    setUploading(true)
    setError(null)
    setResult(null)

    const form = new FormData()
    form.append('file', file)
    form.append('league_id', leagueId)
    form.append('role_code', roleCode)
    form.append('version', version.trim())

    try {
      const res  = await fetch('/api/pitboss/admin/rulebook/upload', {
        method: 'POST',
        body:   form,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Upload failed')
        return
      }

      setResult(data)
      setFile(null)
      setVersion('')
      if (fileRef.current) fileRef.current.value = ''
      // keep leagueId/roleCode selected so the next upload for the same role is easy
    } catch {
      setError('Network error — try again')
    } finally {
      setUploading(false)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Rulebook Upload</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          Upload a document to auto-generate exam questions
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {result && (
        <div className="mb-6 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-4">
          <p className="text-xs font-bold text-green-400 uppercase tracking-wide mb-2">Upload Successful</p>
          <p className="text-sm text-white font-bold">Role: {result.role_code}</p>
          <p className="text-xs text-white/40 mt-1">
            {result.questions_inserted} of {result.target_count} target questions generated via the internal LLM
          </p>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {/* League picker */}
        <div>
          <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">League</label>
          <select
            value={leagueId}
            onChange={(e) => setLeagueId(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white"
          >
            {leagues.map((l) => (
              <option key={l.id} value={l.id} className="bg-neutral-900">
                {l.name}
              </option>
            ))}
          </select>
        </div>

        {/* Role picker */}
        <div>
          <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Certification Role</label>
          <select
            value={roleCode}
            onChange={(e) => setRoleCode(e.target.value)}
            disabled={roles.length === 0}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white disabled:opacity-40"
          >
            {roles.length === 0 && <option className="bg-neutral-900">No roles configured for this league</option>}
            {roles.map((r) => (
              <option key={r.role_code} value={r.role_code} className="bg-neutral-900">
                {r.role_name} ({r.question_count} questions)
              </option>
            ))}
          </select>
        </div>

        {/* Version */}
        <div>
          <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Document Version</label>
          <input
            type="text"
            placeholder="e.g. v2.1 or 2027-Season"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/20"
          />
        </div>

        {/* File picker */}
        <div>
          <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Document</label>
          <div
            onClick={() => fileRef.current?.click()}
            className="w-full rounded-xl border border-dashed border-white/20 bg-white/5 px-4 py-6 text-center cursor-pointer"
          >
            {file ? (
              <div>
                <p className="text-sm font-bold text-white">{file.name}</p>
                <p className="text-xs text-white/30 mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            ) : (
              <div>
                <p className="text-sm text-white/40">Tap to select a PDF</p>
                <p className="text-xs text-white/20 mt-1">PDF only — max 50MB</p>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {/* Upload button */}
        <button
          onClick={handleUpload}
          disabled={uploading || !file || !leagueId || !roleCode || !version.trim()}
          className="w-full rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40 mt-2"
        >
          {uploading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              Generating via internal LLM…
            </span>
          ) : (
            'Upload & Generate Exam'
          )}
        </button>

        <p className="text-xs text-white/20 text-center">
          The internal PitBoss LLM gateway reads the rulebook and generates questions for the role
          you selected above, sized to that role&apos;s exam length. New questions are added to the
          existing pool for this role — they don&apos;t replace it.
        </p>
      </div>
    </main>
  )
}
