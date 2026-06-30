import { Suspense } from 'react'
import { StewardResultsInner } from '@/components/steward/StewardResultsInner'

export default function StewardResultsPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-rise-black">
          <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </main>
      }
    >
      <StewardResultsInner />
    </Suspense>
  )
}
