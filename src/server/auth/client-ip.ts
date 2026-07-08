// Best-effort client IP for rate-limit keying. On Vercel the real client IP is the FIRST entry of
// `x-forwarded-for` (Vercel appends its own proxy hops after it); `x-real-ip` is the fallback. When
// neither header is present (local dev, unit tests, non-proxied runtime) we key on a shared sentinel
// so the limiter degrades to a single global bucket rather than throwing.
//
// This is intentionally header-derived and therefore best-effort: it is spoofable upstream of a
// trusted proxy and coarse behind shared NAT. That trade-off is documented in rate-limit-constants.ts.
export const UNKNOWN_CLIENT_IP = "unknown";

export const extractClientIp = (getHeader: (name: string) => string | null | undefined): string => {
  const forwardedFor = getHeader("x-forwarded-for");
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = getHeader("x-real-ip");
  if (typeof realIp === "string" && realIp.trim().length > 0) {
    return realIp.trim();
  }

  return UNKNOWN_CLIENT_IP;
};
