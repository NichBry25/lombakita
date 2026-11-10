// @vitest-environment node

// MANUAL-D57, the institution-media wrapper.
//
// The logo and banner routes share `runOwnedUploadUrl`, so the budget is drawn there once rather
// than in either route file. The two cases are split for the same reason the other two files
// split them: a guard that was REMOVED and a guard that was MOVED below the presign are
// indistinguishable by status code, because the moved one still answers 429, for a URL it has
// already signed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

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

const makeRequest = (headers: Record<string, string> = {}, mimeType = "image/png") =>
  new Request("http://localhost/api/v1/institutions/academy/profile/logo/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ mimeType }),
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

describe("POST institutions/[institutionSlug]/profile/logo/upload-url", () => {
  it("mints the presigned grant for an authenticated owner", async () => {
    const res = await POST(makeRequest(), context);

    expect(res.status).toBe(201);
    expect((await res.json()).uploadUrl).toBe("https://signed.example/put");
    expect(generateInstitutionMediaUploadUrl).toHaveBeenCalledWith("usr_1", "academy", "logo", {
      contentType: "image/png",
    });
  });

  it("returns 401 when unauthenticated, without counting a budget draw", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await POST(makeRequest(), context);

    expect(res.status).toBe(401);
    expect(checkFixedWindowLimit).not.toHaveBeenCalled();
  });

  it("refuses a request for another account before charging the budget or signing", async () => {
    const res = await POST(makeRequest({ [SESSION_USER_HEADER]: "usr_other" }), context);

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("session_user_mismatch");
    expect(generateInstitutionMediaUploadUrl).not.toHaveBeenCalled();
    expect(checkFixedWindowLimit).not.toHaveBeenCalled();
  });

  it("refuses a file type the route does not accept, without signing", async () => {
    const res = await POST(makeRequest({}, "image/gif"), context);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("institution_profile_invalid_value");
    expect(generateInstitutionMediaUploadUrl).not.toHaveBeenCalled();
  });
});

describe("POST institutions/[institutionSlug]/profile/logo/upload-url — the shared upload-URL budget", () => {
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
