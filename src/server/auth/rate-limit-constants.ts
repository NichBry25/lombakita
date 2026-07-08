// Auth rate-limit policy. Thresholds, window durations, and Redis key prefixes live here (never
// inlined at the call site) so the generic primitive in server/redis/rate-limit.ts stays policy-free
// and every tunable is changed in one place.
//
// IP-based limiting is best-effort: clients behind a shared NAT share one bucket, and the forwarded
// header is spoofable upstream of a trusted proxy. Accepted at MVP pre-UAT — this raises the cost of
// enumeration/brute-force sweeps without claiming per-client precision.

// Fixed-window request limiter on POST /api/v1/auth/identify, keyed by client IP. The identify
// endpoint is an acknowledged email-enumeration oracle (6.5d.1-D1); this caps how fast it can be
// swept. One legitimate sign-in issues a single identify call, so the ceiling is generous for real
// users while throttling automated sweeps.
export const IDENTIFY_RATE_LIMIT = {
  limit: 60,
  windowSeconds: 60,
  keyPrefix: "rl:identify:",
} as const;

// Failed-attempt limiter on the credentials login path, keyed by (client IP + email). Counts only
// failed password attempts; a success clears the counter. After `limit` consecutive failures within
// the window, further attempts for that key are refused — even with the correct password — until the
// window elapses.
export const LOGIN_FAILED_ATTEMPT_LIMIT = {
  limit: 5,
  windowSeconds: 15 * 60,
  keyPrefix: "rl:login-fail:",
} as const;

// Prefix for the single-use OAuth carrier nonce (auth-D2 / 6.5d-D2). The carrier's `jti` is appended
// and consumed via an atomic SET NX at finalize so a captured /auth/login?oauth=<carrier> URL cannot
// be redeemed a second time inside its 15-minute TTL.
export const OAUTH_CARRIER_NONCE_KEY_PREFIX = "oauth_carrier_consumed:";
