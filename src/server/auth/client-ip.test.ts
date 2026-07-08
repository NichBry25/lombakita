// @vitest-environment node

import { describe, expect, it } from "vitest";
import { extractClientIp, UNKNOWN_CLIENT_IP } from "@/server/auth/client-ip";

// Header lookup helper mirroring how callers pass headers (a get-by-name function). Case is the
// caller's concern (Headers.get is case-insensitive; the Node record is lowercased), so tests key by
// the lowercase names the callers use.
const fromMap =
  (map: Record<string, string>) =>
  (name: string): string | null =>
    map[name] ?? null;

describe("extractClientIp", () => {
  it("takes the first hop of x-forwarded-for (the real client on Vercel)", () => {
    expect(extractClientIp(fromMap({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }))).toBe(
      "203.0.113.7",
    );
  });

  it("trims whitespace around the first forwarded hop", () => {
    expect(extractClientIp(fromMap({ "x-forwarded-for": "  203.0.113.7 , 70.41.3.18" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(extractClientIp(fromMap({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
  });

  it("returns the unknown sentinel when no forwarded headers are present", () => {
    expect(extractClientIp(fromMap({}))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("returns the unknown sentinel when x-forwarded-for is empty or whitespace-only", () => {
    expect(extractClientIp(fromMap({ "x-forwarded-for": "" }))).toBe(UNKNOWN_CLIENT_IP);
    expect(extractClientIp(fromMap({ "x-forwarded-for": "   " }))).toBe(UNKNOWN_CLIENT_IP);
  });
});
