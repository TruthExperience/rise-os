'use client'

import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/browser'

interface EvidenceItem {
  id: string
  party: 'reporter' | 'accused'
  source: 'upload' | 'link'
  url: string
  label: string | null
  added_by_role: 'reporter' | 'accused' | 'steward'
  created_at: string | null
  legacy?: boolean
}

interface EvidenceCaptureProps {
  incidentId: string
  party: 'reporter' | 'accused'
  onAdded: (item: EvidenceItem) => void
  compact?: boolean
}

export function EvidenceCapture({ incidentId, party, onAdded, compact = false }: EvidenceCaptureProps) {
  const [mode, setMode] = useState<'link' | 'upload'>('link')
  const [linkUrl, setLinkUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  async function submitLink() {
    if (!linkUrl.trim()) return
    await postEvidence('link', linkUrl.trim())
    setLinkUrl('')
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const path = `${incidentId}/${party}-${Date.now()}-${file.name}`
      const { error: uploadError } = await supabaseBrowser.storage
        .from('incident-evidence')
        .upload(path, file)
      if (uploadError) throw uploadError

      // Bucket is private — store the raw storage path, not a public URL.
      // The server resolves this into a short-lived signed URL whenever
      // this evidence is actually fetched for display.
      await postEvidence('upload', path, file.name)
    } catch (err: any) {
      setError(err.message ?? 'Upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function postEvidence(source: 'link' | 'upload', url: string, label?: string) {
    setError('')
    try {
      const res = await fetch(`/api/pitboss/incidents/${incidentId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ party, source, url, label: label ?? null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to add evidence')
      onAdded(data.evidence)
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex gap-2">
        <button
          onClick={() => setMode('link')}
          className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wide ${
            mode === 'link' ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/40'
          }`}
        >
          Paste Link
        </button>
        <button
          onClick={() => setMode('upload')}
          className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wide ${
            mode === 'upload' ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/40'
          }`}
        >
          Upload Clip
        </button>
      </div>

      {mode === 'link' ? (
        <div className="flex gap-2">
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            className="flex-1 bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-blue-400/60 focus:outline-none placeholder-white/20"
          />
          <button
            onClick={submitLink}
            disabled={!linkUrl.trim()}
            className="bg-blue-600 disabled:bg-white/10 disabled:text-white/20 text-white font-bold px-4 rounded-xl text-sm"
          >
            Add
          </button>
        </div>
      ) : (
        <div>
          <label className="flex items-center justify-center gap-2 bg-white/5 border border-dashed border-white/20 rounded-xl px-4 py-4 cursor-pointer text-white/50 text-sm">
            {uploading ? 'Uploading…' : '📹 Choose a video file'}
            <input
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  )
}

export type { EvidenceItem }
