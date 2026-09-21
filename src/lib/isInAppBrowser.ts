// Detects likely in-app / webview browsers (Discord, Instagram, etc.) so we
// can warn users their session won't carry over instead of letting them
// hit a silent 401 on authed routes.
//
// Apps like Instagram/Facebook/Line/Snapchat/WeChat/Twitter/TikTok tag
// their webview UA with an identifiable string. Discord's iOS webview does
// not — it uses the system WKWebView UA, which (per WebKit's own behavior)
// omits the trailing "Safari/<version>" token that regular mobile Safari
// always includes. That omission is the fallback signal for "unnamed"
// webviews like Discord's.
//
// Works both client-side (pass navigator.userAgent) and server-side in
// middleware (pass the request's user-agent header) — it's a pure string
// check with no DOM/window dependency.
const NAMED_INAPP_PATTERNS =
  /Instagram|FBAN|FBAV|Line\/|MicroMessenger|Twitter|Snapchat|TikTok/i

export function isLikelyInAppBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false

  if (NAMED_INAPP_PATTERNS.test(userAgent)) return true

  const isIOS = /iPhone|iPad|iPod/i.test(userAgent)
  const isSafariFamily = /AppleWebKit/i.test(userAgent)
  const hasSafariToken = /Safari\/[\d.]+/i.test(userAgent)

  // Real mobile Safari always carries a "Safari/<version>" token. An iOS
  // WKWebView-based in-app browser (Discord, Gmail, Slack, etc.) typically
  // doesn't. Android in-app browsers are far less consistent here, so this
  // fallback is iOS-only — Android falls through to "not detected" rather
  // than risk false positives.
  if (isIOS && isSafariFamily && !hasSafariToken) return true

  return false
}

// Best-effort "escape" link. iOS's x-safari-https:// scheme forces Safari
// to open the given URL when the surrounding app respects it. Not every
// in-app browser honors it (Discord's support is inconsistent), so callers
// should always show the plain URL as a manual/copy fallback too.
export function safariEscapeUrl(targetUrl: string): string {
  return targetUrl.replace(/^https:\/\//, 'x-safari-https://')
}
