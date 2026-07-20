'use client'

import { useEffect } from 'react'

/**
 * next-pwa (skipWaiting + clientsClaim) makes a new service worker take
 * over as soon as it's installed — but that only affects *future*
 * fetches. An already-open page keeps running the old JS it already
 * loaded until it navigates or reloads.
 *
 * On iOS in particular, tapping the home-screen icon usually *resumes*
 * the existing WKWebView process rather than doing a fresh navigation,
 * so the browser's normal "check for SW update on navigation" never
 * fires. That's how a fix can be live in production for 25+ minutes
 * while an already-open PWA session still renders the pre-fix UI.
 *
 * This component closes both gaps:
 *  1. Reload immediately once a new service worker takes control
 *     (controllerchange).
 *  2. Proactively ask the service worker to check for an update
 *     whenever the app becomes visible again (covers the "resumed
 *     from background, never actually reloaded" case on iOS).
 */
export function SwUpdateListener() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    let reloading = false
    const onControllerChange = () => {
      // Guard against a possible double-fire; we only want one reload.
      if (reloading) return
      reloading = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    const checkForUpdate = () => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        reg?.update().catch(() => {
          // Network hiccup on a background check isn't worth surfacing.
        })
      })
    }

    // Covers iOS "resumed from background" — no navigation happens,
    // so the browser never runs its own update check on its own.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', checkForUpdate)

    // Also check once on mount, in case the app was opened stale.
    checkForUpdate()

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', checkForUpdate)
    }
  }, [])

  return null
}
