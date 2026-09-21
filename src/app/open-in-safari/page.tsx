'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { safariEscapeUrl } from '@/lib/isInAppBrowser'

export default function OpenInSafariPage() {
  const searchParams = useSearchParams()
  const next = searchParams.get('next') ?? '/'
  const [fullUrl, setFullUrl] = useState<string | null>(null)

  useEffect(() => {
    setFullUrl(`${window.location.origin}${next}`)
  }, [next])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-rise-black px-6 text-center">
      <p className="text-2xl font-black text-white mb-2">Open in Safari</p>
      <p className="text-sm text-white/40 max-w-xs mb-6">
        You opened this link inside an app (like Discord), which doesn't
        share your login with Safari. Open it in Safari to sign in and
        continue.
      </p>

      {fullUrl && (
        <>
          <a
            href={safariEscapeUrl(fullUrl)}
            className="rounded-xl bg-rise-red px-5 py-2.5 text-sm font-bold text-white mb-4"
          >
            Open in Safari
          </a>
          <p className="text-[11px] text-white/25 max-w-xs">
            If that doesn't work, tap the{' '}
            <span className="text-white/40">•••</span> or compass icon in
            the toolbar below and choose "Open in Safari" — or copy this
            link and paste it into Safari directly:
          </p>
          <p className="mt-3 text-[11px] text-white/40 break-all max-w-xs select-all">
            {fullUrl}
          </p>
        </>
      )}
    </main>
  )
}
