// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { requireSessionRole, getLatestRecruiterVerificationForUser, submitRecruiterVerification } =
  vi.hoisted(() => ({
    requireSessionRole: vi.fn(),
    getLatestRecruiterVerificationForUser: vi.fn(),
    submitRecruiterVerification: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/recruiter-verification/recruiter-verification-service", () => ({
  getLatestRecruiterVerificationForUser,
  submitRecruiterVerification,
}));

import { GET, toRecruiterVerificationView } from "./route";

const recruiterSession = {
  user: { id: "rec_1", role: "recruiter", email: "rec@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const NOW = new Date("2026-07-01T00:00:00.000Z");

// A fully-populated reviewed submission: the two internal fields (reviewerUserId, emailDomainFlag)
// are set to sentinel values the response must never carry back to the reviewed recruiter.
const reviewedSubmission = {
  id: "sub_1",
  userId: "rec_1",
  fullName: "Wisnu Aditya",
  mobileNumber: "0813456789",
  corporateEmail: "wisnu@perusahaan.co.id",
  emailDomainFlag: true,
  vouchedAt: null,
  status: "rejected" as const,
  reviewerUserId: "ops_SECRET_reviewer_id",
  rejectionReason: "Dokumen tidak jelas",
  resubmissionAllowed: true,
  resubmissionCount: 1,
  firstSubmittedAt: NOW,
  submittedAt: NOW,
  reviewedAt: NOW,
};

const attachedDocument = {
  id: "doc_1",
  submissionId: "sub_1",
  r2Key: "recruiter-verification/rec_1/sub_1/abc",
  originalFileName: "surat-tugas.pdf",
  fileSizeBytes: 1024,
  contentType: "application/pdf",
  createdAt: NOW,
};

describe("GET /api/v1/recruiter/me/verification", () => {
  afterEach(() => vi.clearAllMocks());

  it("omits the reviewer identity and the internal queue-priority flag from the response", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    getLatestRecruiterVerificationForUser.mockResolvedValue({
      submission: reviewedSubmission,
      documents: [attachedDocument],
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    // Internal fields the recruiter has no business seeing must be absent.
    expect(body.verification.submission).not.toHaveProperty("reviewerUserId");
    expect(body.verification.submission).not.toHaveProperty("emailDomainFlag");
    // Belt-and-suspenders: the reviewer id sentinel must not appear anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain("ops_SECRET_reviewer_id");
    // The r2Key (storage internal) is also not projected onto documents.
    expect(body.verification.documents[0]).not.toHaveProperty("r2Key");
  });

  it("keeps the recruiter's own data and the review outcome", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    getLatestRecruiterVerificationForUser.mockResolvedValue({
      submission: reviewedSubmission,
      documents: [attachedDocument],
    });

    const response = await GET();
    const body = await response.json();

    expect(body.verification.submission).toMatchObject({
      id: "sub_1",
      status: "rejected",
      fullName: "Wisnu Aditya",
      mobileNumber: "0813456789",
      corporateEmail: "wisnu@perusahaan.co.id",
      rejectionReason: "Dokumen tidak jelas",
    });
    expect(body.verification.documents[0]).toMatchObject({
      id: "doc_1",
      originalFileName: "surat-tugas.pdf",
    });
  });

  it("returns { verification: null } when the account has never submitted", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    getLatestRecruiterVerificationForUser.mockResolvedValue(null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ verification: null });
  });
});

describe("toRecruiterVerificationView", () => {
  it("is a pure whitelist — never leaks reviewerUserId or emailDomainFlag", () => {
    const view = toRecruiterVerificationView({
      submission: reviewedSubmission,
      documents: [attachedDocument],
    });

    expect(Object.keys(view.submission).sort()).toEqual(
      [
        "corporateEmail",
        "fullName",
        "id",
        "mobileNumber",
        "reviewedAt",
        "rejectionReason",
        "resubmissionAllowed",
        "resubmissionCount",
        "status",
        "submittedAt",
        "vouchedAt",
      ].sort(),
    );
    expect(view.documents[0]).toBeDefined();
    expect(Object.keys(view.documents[0]!).sort()).toEqual(
      ["createdAt", "id", "originalFileName"].sort(),
    );
  });
});
