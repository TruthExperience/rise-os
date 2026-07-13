import { Suspense } from 'react'
import CertPageClient from './CertPageClient'

export default function CertPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-rise-black">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </main>
      }
    >
      <CertPageClient />
    </Suspense>
  )
}
