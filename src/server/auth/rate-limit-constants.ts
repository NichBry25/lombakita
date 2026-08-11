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

/**
 * Fixed-window limiter across the three MFA lifecycle routes (enrol-confirm, challenge, recovery),
 * enforced FAIL-CLOSED in `withMfaRouteAuth`. Three properties of this one differ from every
 * limiter above it, and each is deliberate.
 *
 * KEYED BY USER ID, NOT BY IP. These routes are authenticated, so a stable non-spoofable identity
 * is already in hand, and the thing under attack is one account's factor. An IP key would hand an
 * attacker with a botnet a fresh bucket per host while punishing a shared campus NAT; a user-id key
 * cannot be rotated by the attacker at all. This is strictly stronger than the identify limiter's
 * best-effort IP keying, not a variation on it.
 *
 * ONE BUCKET FOR ALL THREE ROUTES. A TOTP guess and a recovery-code guess are attempts against the
 * same factor and already share the database lockout counter; letting them hold separate request
 * budgets would just mean the ceiling is really twice what it says. Enrol-confirm joins them because
 * an account that can reach it is one that has no verified factor to attack anyway.
 *
 * IT IS THE OUTER, CHEAPER BOUND, AND ON TWO OF THE THREE ROUTES IT IS NOT THE ONLY ONE. For
 * challenge and recovery the database counter (MFA_LOCKOUT_THRESHOLD, 5 per 15 minutes) is what
 * actually limits guesses, and it survives a Redis outage because it lives in Postgres; this limiter
 * only stops a flood before it reaches Postgres at all, so at 10 per minute a legitimate operator
 * making two or three calls never sees it.
 *
 * THAT SECOND BOUND DOES NOT COVER THE WHOLE LIFECYCLE, and the difference matters when reasoning
 * about what a Redis outage costs. The enrolment page calls `startMfaEnrolment` on every render,
 * which resets `failed_attempt_count` and `locked_until` — and that call sits outside this wrapper
 * entirely, so the page render is neither counted here nor bounded there. On that path this
 * limiter is not the outer bound; it is the only one, and it is not on it. Do not read the paragraph
 * above as "MFA is rate limited" — read it as "challenge and recovery are, twice over".
 */
export const MFA_ROUTE_RATE_LIMIT = {
  limit: 10,
  windowSeconds: 60,
  keyPrefix: "rl:mfa:",
} as const;
