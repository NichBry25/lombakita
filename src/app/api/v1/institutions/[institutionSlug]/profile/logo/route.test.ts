// @vitest-environment node

// MANUAL-D57, the institution-media wrapper.
//
// The logo and banner routes share `runOwned`, so the budget is drawn there once rather than in
// either route file. The two cases are split for the same reason the other two files split them: a
// guard that was REMOVED and a guard that was MOVED below the presign are indistinguishable by
// status code — the moved one still answers 429, for a URL it has already signed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, generateInstitutionMediaUploadUrl, checkFixedWindowLimit } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    generateInstitutionMediaUploadUrl: vi.fn(),
    checkFixedWindowLimit: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-workspace/institution-media-service", () => ({
  generateInstitutionMediaUploadUrl,
}));
vi.mock("@/server/redis/rate-limit", () => ({ checkFixedWindowLimit }));

import { POST } from "./route";
import { UPLOAD_URL_RATE_LIMIT } from "@/server/storage/upload-rate-limit";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const REFUSED = { allowed: false, retryAfterSeconds: 42 };

const session = {
  user: { id: "usr_1", role: "recruiter", email: "penyelenggara@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = { params: Promise.resolve({ institutionSlug: "academy" }) };

const makeRequest = () =>
  new Request("http://localhost/api/v1/institutions/academy/profile/logo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mimeType: "image/png" }),
  });

beforeEach(() => {
  requireAuthenticatedSession.mockResolvedValue(session);
  generateInstitutionMediaUploadUrl.mockResolvedValue({
    uploadUrl: "https://signed.example/put",
    fileKey: "institution-logos/academy/uuid.png",
    expiresAt: new Date(),
  });
  checkFixedWindowLimit.mockResolvedValue(ALLOWED);
});

afterEach(() => vi.clearAllMocks());

describe("POST institutions/[institutionSlug]/profile/logo", () => {
  it("mints the presigned grant for an authenticated owner", async () => {
    const res = await POST(makeRequest(), context);

    expect(res.status).toBe(201);
    expect((await res.json()).uploadUrl).toBe("https://signed.example/put");
  });

  it("returns 401 when unauthenticated, without counting a budget draw", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await POST(makeRequest(), context);

    expect(res.status).toBe(401);
    expect(checkFixedWindowLimit).not.toHaveBeenCalled();
  });
});

describe("POST institutions/[institutionSlug]/profile/logo — the shared upload-URL budget", () => {
  it("counts the calling user against the shared upload-URL bucket", async () => {
    await POST(makeRequest(), context);

    expect(checkFixedWindowLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: `${UPLOAD_URL_RATE_LIMIT.keyPrefix}usr_1` }),
    );
  });

  it("refuses an over-budget request with 429 and a Retry-After", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const res = await POST(makeRequest(), context);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  it("does not mint an upload URL for a request the budget refuses", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    await POST(makeRequest(), context);

    expect(generateInstitutionMediaUploadUrl).not.toHaveBeenCalled();
  });
});
