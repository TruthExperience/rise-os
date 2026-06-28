import { Suspense } from 'react'
import { StewardInner } from './StewardInner'

export default function StewardPage() {
  return (
    <Suspense fallback={
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    }>
      <StewardInner />
    </Suspense>
  )
}
