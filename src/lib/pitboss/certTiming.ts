// Single source of truth for the certification exam clock.
// The exam page counts down EXAM_TIME_LIMIT_SECONDS. The server accepts a
// submit up to EXAM_GRACE_SECONDS later, so a timer that auto-submits at 0:00
// isn't rejected because of network latency or a slow phone.
export const EXAM_TIME_LIMIT_SECONDS = 45 * 60
export const EXAM_GRACE_SECONDS = 2 * 60
export const CERT_WINDOW_MS = (EXAM_TIME_LIMIT_SECONDS + EXAM_GRACE_SECONDS) * 1000
