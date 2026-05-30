// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { SubmissionError } from "@/server/submissions/submission-core";

const { requireSessionRole, generateSubmissionUploadUrl } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  generateSubmissionUploadUrl: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/submissions/submission-service", () => ({ generateSubmissionUploadUrl }));

import { POST } from "./route";

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
