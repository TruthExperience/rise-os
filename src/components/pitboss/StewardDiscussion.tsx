'use client'

import { useEffect, useState } from 'react'

interface Comment {
  id: string
  driver_id: string
  body: string
  created_at: string
  drivers: { display_name: string | null; discord_username: string } | null
}

function commentAuthorName(c: Comment) {
  return c.drivers?.display_name ?? c.drivers?.discord_username ?? 'Steward'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export function StewardDiscussion({ incidentId }: { incidentId: string }) {
  const [comments, setComments] = useState<Comment[]>([])
  const [text, setText]         = useState('')
  const [loading, setLoading]   = useState(true)
  const [posting, setPosting]   = useState(false)
  const [error, setError]       = useState('')

  async function load() {
    try {
      const res  = await fetch(`/api/pitboss/incidents/${incidentId}/comments`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load discussion')
      setComments(data.comments ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [incidentId])

  async function handlePost() {
    if (!text.trim()) return
    setPosting(true)
    setError('')
    try {
      const res  = await fetch(`/api/pitboss/incidents/${incidentId}/comments`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ body: text.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to post')
      setText('')
      await load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="bg-white/5 rounded-2xl px-4 py-4 space-y-3">
      {loading ? (
        <p className="text-white/20 text-sm">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-white/20 text-sm">No discussion yet — this feeds the AI analysis below.</p>
      ) : (
        <div className="space-y-3 max-h-64 overflow-y-auto">
          {comments.map((c) => (
            <div key={c.id}>
              <div className="flex items-baseline gap-2">
                <span className="text-white text-xs font-bold">{commentAuthorName(c)}</span>
                <span className="text-white/20 text-[10px]">{formatDate(c.created_at)}</span>
              </div>
              <p className="text-white/70 text-sm leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="flex gap-2 pt-2 border-t border-white/10">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add discussion note…"
          className="flex-1 bg-white/5 text-white text-sm px-3 py-2 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
          onKeyDown={(e) => e.key === 'Enter' && handlePost()}
        />
        <button
          onClick={handlePost}
          disabled={!text.trim() || posting}
          className="px-4 py-2 rounded-xl bg-rise-red disabled:bg-white/10 disabled:text-white/20 text-white text-xs font-bold"
        >
          {posting ? '…' : 'Post'}
        </button>
      </div>
    </div>
  )
}
