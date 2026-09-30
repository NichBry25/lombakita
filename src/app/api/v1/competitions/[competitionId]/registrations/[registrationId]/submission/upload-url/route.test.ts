// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { SubmissionError } from "@/server/submissions/submission-core";

const { requireSessionRole, generateSubmissionUploadUrl, checkFixedWindowLimit } = vi.hoisted(
  () => ({
    requireSessionRole: vi.fn(),
    generateSubmissionUploadUrl: vi.fn(),
    checkFixedWindowLimit: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/submissions/submission-service", () => ({ generateSubmissionUploadUrl }));
// The limiter's own arithmetic is not under test here; what is under test is that this route draws
// the budget and that the refusal stops the mint. Mocking the window keeps a live Redis out of it.
vi.mock("@/server/redis/rate-limit", () => ({ checkFixedWindowLimit }));

import { POST } from "./route";
import { UPLOAD_URL_RATE_LIMIT } from "@/server/storage/upload-rate-limit";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const REFUSED = { allowed: false, retryAfterSeconds: 42 };

const candidateSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = () => ({
  params: Promise.resolve({ competitionId: "comp_1", registrationId: "reg_1" }),
});

const makeRequest = (body: unknown) =>
  new Request(
    "http://localhost/api/v1/competitions/comp_1/registrations/reg_1/submission/upload-url",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

describe("POST submission/upload-url", () => {
  beforeEach(() => {
    checkFixedWindowLimit.mockResolvedValue(ALLOWED);
  });

  afterEach(() => vi.clearAllMocks());

  it("returns 200 with the presigned grant", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    generateSubmissionUploadUrl.mockResolvedValue({
      uploadUrl: "https://signed.example/put",
      fileKey: "submissions/reg_1/uuid",
      expiresAt: new Date(),
    });
    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.uploadUrl).toBe("https://signed.example/put");
    expect(body.fileKey).toBe("submissions/reg_1/uuid");
  });

  it("returns 503 submission_upload_unavailable when R2 is not configured", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    generateSubmissionUploadUrl.mockRejectedValue(
      new SubmissionError("submission_upload_unavailable", "unavailable"),
    );
    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("submission_upload_unavailable");
  });

  it("returns 404 when the registration is inaccessible", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    generateSubmissionUploadUrl.mockRejectedValue(
      new SubmissionError("submission_registration_not_found", "not found"),
    );
    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-candidate", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());
    expect(res.status).toBe(403);
  });
});

// MANUAL-D57. Two cases, deliberately asserting different things, because the two failures they
// guard against are indistinguishable by status code alone: a guard that was REMOVED, and a guard
// that was MOVED below the mint. The second still answers 429 — for a URL that was already signed.
//
// The first case asserts the status and nothing about the service; the second asserts the service
// and nothing about the status. Collapsing them into one case would let either probe cite the other
// probe's assertion as its evidence.
describe("POST submission/upload-url — the shared upload-URL budget", () => {
  beforeEach(() => {
    requireSessionRole.mockResolvedValue(candidateSession);
    generateSubmissionUploadUrl.mockResolvedValue({
      uploadUrl: "https://signed.example/put",
      fileKey: "submissions/reg_1/uuid",
      expiresAt: new Date(),
    });
    checkFixedWindowLimit.mockResolvedValue(ALLOWED);
  });

  afterEach(() => vi.clearAllMocks());

  it("counts the calling user against the shared upload-URL bucket", async () => {
    await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());

    expect(checkFixedWindowLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: `${UPLOAD_URL_RATE_LIMIT.keyPrefix}stud_1` }),
    );
  });

  it("refuses an over-budget request with 429 and a Retry-After", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  it("does not mint an upload URL for a request the budget refuses", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());

    expect(generateSubmissionUploadUrl).not.toHaveBeenCalled();
  });

  it("leaves an under-budget request to mint as before", async () => {
    const res = await POST(makeRequest({ fileName: "report.pdf" }) as never, makeContext());

    expect(res.status).toBe(200);
    expect(generateSubmissionUploadUrl).toHaveBeenCalledOnce();
  });
});
