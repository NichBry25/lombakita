// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { SubmissionError } from "@/server/submissions/submission-core";

const { requireSessionRole, getSubmission, createOrReplaceSubmission } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  getSubmission: vi.fn(),
  createOrReplaceSubmission: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/submissions/submission-service", () => ({
  getSubmission,
  createOrReplaceSubmission,
}));

import { GET, PUT } from "./route";

const candidateSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = () => ({
  params: Promise.resolve({ competitionId: "comp_1", registrationId: "reg_1" }),
});

const submissionRecord = {
  id: "sub_1",
  registrationId: "reg_1",
  fileName: "report.pdf",
  fileKey: "submissions/reg_1/abc",
  version: 1,
  finalizedAt: null,
};

const getRequest = () =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations/reg_1/submission");

const putRequest = (body: unknown, raw?: string) =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations/reg_1/submission", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });

describe("GET submission", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with the submission", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getSubmission.mockResolvedValue(submissionRecord);
    const res = await GET(getRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.submission.id).toBe("sub_1");
  });

  it("returns 200 with null when no submission exists", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getSubmission.mockResolvedValue(null);
    const res = await GET(getRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.submission).toBeNull();
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await GET(getRequest() as never, makeContext());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-candidate", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await GET(getRequest() as never, makeContext());
    expect(res.status).toBe(403);
  });

  it("returns 404 when the registration is inaccessible", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getSubmission.mockRejectedValue(
      new SubmissionError("submission_registration_not_found", "not found"),
    );
    const res = await GET(getRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("submission_registration_not_found");
  });

  it("returns 409 when the registration is cancelled", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getSubmission.mockRejectedValue(
      new SubmissionError("submission_registration_cancelled", "cancelled"),
    );
    const res = await GET(getRequest() as never, makeContext());
    expect(res.status).toBe(409);
  });
});

describe("PUT submission", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with the recorded submission", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    createOrReplaceSubmission.mockResolvedValue(submissionRecord);
    const res = await PUT(
      putRequest({ fileKey: "submissions/reg_1/abc", fileName: "report.pdf" }) as never,
      makeContext(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.submission.id).toBe("sub_1");
    expect(createOrReplaceSubmission).toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    const res = await PUT(putRequest(undefined, "{not json") as never, makeContext());
    expect(res.status).toBe(400);
    expect(createOrReplaceSubmission).not.toHaveBeenCalled();
  });

  it("returns 422 submission_invalid_file_key when fileKey is missing", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    const res = await PUT(putRequest({ fileName: "report.pdf" }) as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("submission_invalid_file_key");
    expect(createOrReplaceSubmission).not.toHaveBeenCalled();
  });

  it("returns 422 when the submission window is closed", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    createOrReplaceSubmission.mockRejectedValue(
      new SubmissionError("submission_window_closed", "closed"),
    );
    const res = await PUT(
      putRequest({ fileKey: "submissions/reg_1/abc", fileName: "report.pdf" }) as never,
      makeContext(),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when the submission is finalized", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    createOrReplaceSubmission.mockRejectedValue(
      new SubmissionError("submission_finalized", "locked", { status: 422 }),
    );
    const res = await PUT(
      putRequest({ fileKey: "submissions/reg_1/abc", fileName: "report.pdf" }) as never,
      makeContext(),
    );
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("submission_finalized");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await PUT(
      putRequest({ fileKey: "submissions/reg_1/abc", fileName: "report.pdf" }) as never,
      makeContext(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-candidate", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await PUT(
      putRequest({ fileKey: "submissions/reg_1/abc", fileName: "report.pdf" }) as never,
      makeContext(),
    );
    expect(res.status).toBe(403);
  });
});
