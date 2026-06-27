'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface League {
  id: string
  name: string
  slug: string
  pitboss_status: string
}

interface UploadState {
  loading: boolean
  success: boolean
  error: string | null
  questionsGenerated: number
}

export default function PitBossAdminPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [leagues, setLeagues]         = useState<League[]>([])
  const [selectedLeague, setSelectedLeague] = useState<string>('')
  const [roleCode, setRoleCode]       = useState<string>('')
  const [docVersion, setDocVersion]   = useState<string>('')
  const [file, setFile]               = useState<File | null>(null)
  const [uploadState, setUploadState] = useState<UploadState>({
    loading: false,
    success: false,
    error: null,
    questionsGenerated: 0,
  })
  const [activeTab, setActiveTab]     = useState<'rulebook' | 'drivers' | 'certs'>('rulebook')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const all = data.leagues ?? data
        setLeagues(all)
        if (all.length > 0) setSelectedLeague(all[0].id)
      })
  }, [status])

  async function handleUpload() {
    if (!file || !selectedLeague || !roleCode) {
      setUploadState((s) => ({
        ...s,
        error: 'Please select a league, role, and PDF file.',
      }))
      return
    }

    setUploadState({ loading: true, success: false, error: null, questionsGenerated: 0 })

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('league_id', selectedLeague)
      formData.append('role_code', roleCode)
      formData.append('doc_version', docVersion || '1.0')

      const res = await fetch('/api/pitboss/rulebook/upload', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setUploadState({
          loading: false,
          success: false,
          error: data.error ?? 'Upload failed',
          questionsGenerated: 0,
        })
        return
      }

      setUploadState({
        loading: false,
        success: true,
        error: null,
        questionsGenerated: data.questions_generated ?? 0,
      })
      setFile(null)
      setRoleCode('')
      setDocVersion('')
    } catch {
      setUploadState({
        loading: false,
        success: false,
        error: 'Network error — try again',
        questionsGenerated: 0,
      })
    }
  }

  const currentLeague = leagues.find((l) => l.id === selectedLeague)

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      {/* Header */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">
          PitBoss <span className="text-rise-red">Admin</span>
        </h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          Commissioner Tools
        </p>
      </div>

      {/* League Selector */}
      <div className="mb-6">
        <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
          Active League
        </label>
        <select
          value={selectedLeague}
          onChange={(e) => setSelectedLeague(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white text-sm focus:outline-none focus:border-rise-red"
        >
          {leagues.map((l) => (
            <option key={l.id} value={l.id} className="bg-[#1A1A1A]">
              {l.name} ({l.slug})
            </option>
          ))}
        </select>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(['rulebook', 'drivers', 'certs'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-xl py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
              activeTab === tab
                ? 'bg-rise-red text-white'
                : 'bg-white/5 text-white/40 border border-white/10'
            }`}
          >
            {tab === 'rulebook' ? 'Rulebook' : tab === 'drivers' ? 'Drivers' : 'Certs'}
          </button>
        ))}
      </div>

      {/* ── RULEBOOK TAB ── */}
      {activeTab === 'rulebook' && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <h2 className="text-sm font-bold text-white mb-1">Upload Rulebook</h2>
            <p className="text-xs text-white/30 mb-4">
              Upload a PDF rulebook to auto-generate certification questions via AI.
            </p>

            {/* Role Code */}
            <div className="mb-3">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                Role Code
              </label>
              <input
                type="text"
                placeholder="e.g. DRV, STW, COM"
                value={roleCode}
                onChange={(e) => setRoleCode(e.target.value.toUpperCase())}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>

            {/* Doc Version */}
            <div className="mb-3">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                Document Version
              </label>
              <input
                type="text"
                placeholder="e.g. v2.0"
                value={docVersion}
                onChange={(e) => setDocVersion(e.target.value)}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>

            {/* File Upload */}
            <div className="mb-5">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                PDF File
              </label>
              <label className="flex flex-col items-center justify-center w-full rounded-xl border-2 border-dashed border-white/10 bg-white/5 px-4 py-6 cursor-pointer hover:border-rise-red/50 transition-colors">
                <span className="text-2xl mb-2">📄</span>
                <span className="text-sm text-white/50">
                  {file ? file.name : 'Tap to select PDF'}
                </span>
                {file && (
                  <span className="text-xs text-white/30 mt-1">
                    {(file.size / 1024).toFixed(0)} KB
                  </span>
                )}
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            {/* Error */}
            {uploadState.error && (
              <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
                <p className="text-xs text-rise-red">{uploadState.error}</p>
              </div>
            )}

            {/* Success */}
            {uploadState.success && (
              <div className="mb-4 rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-3">
                <p className="text-xs text-green-400">
                  ✅ Uploaded successfully — {uploadState.questionsGenerated} questions generated
                </p>
              </div>
            )}

            {/* Upload Button */}
            <button
              onClick={handleUpload}
              disabled={uploadState.loading || !file || !roleCode || !selectedLeague}
              className="w-full rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40 transition-opacity"
            >
              {uploadState.loading ? 'Uploading & Generating...' : 'Upload Rulebook'}
            </button>
          </div>

          {/* League Info */}
          {currentLeague && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h2 className="text-sm font-bold text-white mb-3">League Info</h2>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between">
                  <span className="text-xs text-white/40">Name</span>
                  <span className="text-xs text-white">{currentLeague.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-white/40">Slug</span>
                  <span className="text-xs text-white">{currentLeague.slug}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-white/40">Status</span>
                  <span className={`text-xs font-bold ${
                    currentLeague.pitboss_status === 'active'
                      ? 'text-green-400'
                      : currentLeague.pitboss_status === 'trial'
                      ? 'text-yellow-400'
                      : 'text-white/30'
                  }`}>
                    {currentLeague.pitboss_status.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DRIVERS TAB ── */}
      {activeTab === 'drivers' && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-sm font-bold text-white mb-1">Driver Management</h2>
          <p className="text-xs text-white/30 mb-4">
            View and manage drivers registered to this league.
          </p>
          <button
            onClick={() => router.push(`/pitboss/drivers?league_id=${selectedLeague}`)}
            className="w-full rounded-xl bg-white/10 border border-white/10 py-3 text-sm font-bold text-white"
          >
            View Drivers →
          </button>
        </div>
      )}

      {/* ── CERTS TAB ── */}
      {activeTab === 'certs' && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-sm font-bold text-white mb-1">Certification Management</h2>
          <p className="text-xs text-white/30 mb-4">
            View exam results and manage certifications for this league.
          </p>
          <button
            onClick={() => router.push(`/pitboss/cert/admin?league_id=${selectedLeague}`)}
            className="w-full rounded-xl bg-white/10 border border-white/10 py-3 text-sm font-bold text-white"
          >
            View Certifications →
          </button>
        </div>
      )}
    </main>
  )
}
