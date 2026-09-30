// @vitest-environment node

// MANUAL-D57, the wrapper half.
//
// Four profile upload-URL routes and the two institution media routes are served by `runOwned`, so
// the budget is drawn once in the wrapper rather than once per route file. This asserts it against
// the avatar route as the representative of the profile family, and the two cases are split for the
// same reason the direct-route file splits them: a guard that was REMOVED and a guard that was
// MOVED below the presign are indistinguishable by status code — the moved one still answers 429,
// for a URL it has already signed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, generateAvatarUploadUrl, checkFixedWindowLimit } = vi.hoisted(
  () => ({
    requireAuthenticatedSession: vi.fn(),
    generateAvatarUploadUrl: vi.fn(),
    checkFixedWindowLimit: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/user-profile/profile-files-service", () => ({ generateAvatarUploadUrl }));
vi.mock("@/server/redis/rate-limit", () => ({ checkFixedWindowLimit }));

import { POST } from "./route";
import { UPLOAD_URL_RATE_LIMIT } from "@/server/storage/upload-rate-limit";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const REFUSED = { allowed: false, retryAfterSeconds: 42 };

const session = {
  user: { id: "usr_1", role: "candidate", email: "kandidat@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = () =>
  new Request("http://localhost/api/v1/users/me/profile/uploads/avatar/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: "foto.png", mimeType: "image/png" }),
  });

beforeEach(() => {
  requireAuthenticatedSession.mockResolvedValue(session);
  generateAvatarUploadUrl.mockResolvedValue({
    uploadUrl: "https://signed.example/put",
    fileKey: "avatars/usr_1/uuid.png",
    expiresAt: new Date(),
  });
  checkFixedWindowLimit.mockResolvedValue(ALLOWED);
});

afterEach(() => vi.clearAllMocks());

describe("POST users/me/profile/uploads/avatar/upload-url", () => {
  it("mints the presigned grant for an authenticated caller", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).uploadUrl).toBe("https://signed.example/put");
  });

  it("returns 401 when unauthenticated, without counting a budget draw", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(checkFixedWindowLimit).not.toHaveBeenCalled();
  });
});

describe("POST users/me/profile/uploads/avatar/upload-url — the shared upload-URL budget", () => {
  it("counts the calling user against the shared upload-URL bucket", async () => {
    await POST(makeRequest());

    expect(checkFixedWindowLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: `${UPLOAD_URL_RATE_LIMIT.keyPrefix}usr_1` }),
    );
  });

  it("refuses an over-budget request with 429 and a Retry-After", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const res = await POST(makeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  it("does not mint an upload URL for a request the budget refuses", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    await POST(makeRequest());

    expect(generateAvatarUploadUrl).not.toHaveBeenCalled();
  });
});
