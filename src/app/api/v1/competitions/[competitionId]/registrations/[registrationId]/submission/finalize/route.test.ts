// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { SubmissionError } from "@/server/submissions/submission-core";

const { requireSessionRole, finalizeSubmission } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  finalizeSubmission: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/submissions/submission-service", () => ({ finalizeSubmission }));

import { POST } from "./route";

const candidateSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = () => ({
  params: Promise.resolve({ competitionId: "comp_1", registrationId: "reg_1" }),
});

const makeRequest = () =>
  new Request(
    "http://localhost/api/v1/competitions/comp_1/registrations/reg_1/submission/finalize",
    { method: "POST" },
  );

describe("POST submission/finalize", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with the finalized submission", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    finalizeSubmission.mockResolvedValue({ id: "sub_1", finalizedAt: new Date().toISOString() });
    const res = await POST(makeRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.submission.id).toBe("sub_1");
  });

  it("returns 409 when the submission is already finalized", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    finalizeSubmission.mockRejectedValue(
      new SubmissionError("submission_finalized", "already finalized"),
    );
    const res = await POST(makeRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("submission_finalized");
  });

  it("returns 404 when there is no submission to finalize", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    finalizeSubmission.mockRejectedValue(new SubmissionError("submission_not_found", "none"));
    const res = await POST(makeRequest() as never, makeContext());
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await POST(makeRequest() as never, makeContext());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-candidate", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await POST(makeRequest() as never, makeContext());
    expect(res.status).toBe(403);
  });
});
