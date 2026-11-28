// @vitest-environment node

import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const {
  requireSessionRole,
  assertUploadUrlAllowed,
  createInstagramTickRequest,
  createVerificationSubmission,
  SubmissionError,
} = vi.hoisted(() => {
  // The route tells a SubmissionError by its class, so the mocked module exports the class the test
  // builds its refusal from.
  class SubmissionError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return {
    requireSessionRole: vi.fn(),
    assertUploadUrlAllowed: vi.fn(),
    createInstagramTickRequest: vi.fn(),
    createVerificationSubmission: vi.fn(),
    SubmissionError,
  };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/storage/upload-rate-limit", () => ({ assertUploadUrlAllowed }));
vi.mock("@/server/institution-verification/submission-service", () => ({
  createInstagramTickRequest,
  createVerificationSubmission,
  SubmissionError,
}));

import { POST } from "@/app/api/v1/institutions/[institutionSlug]/verification/submit/route";

const recruiterSession = {
  user: { id: "user_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const DOCUMENTS = [
  {
    documentType: "npwp",
    originalFileName: "npwp.pdf",
    fileSizeBytes: 1024,
    contentType: "application/pdf",
  },
];

const send = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: "user_1" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ institutionSlug: "pt-contoh" }) },
  );

describe("POST /api/v1/institutions/[institutionSlug]/verification/submit", () => {
  afterEach(() => vi.clearAllMocks());

  it("sends an instagram body to the Instagram request and draws no upload budget", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    createInstagramTickRequest.mockResolvedValue({ submissionId: "sub_1", documents: [] });

    const response = await send({
      path: "instagram",
      instagramUrl: "https://instagram.com/acme.org",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ submissionId: "sub_1", documents: [] });
    expect(createInstagramTickRequest).toHaveBeenCalledWith(
      "pt-contoh",
      "https://www.instagram.com/acme.org/",
      "user_1",
    );
    expect(assertUploadUrlAllowed).not.toHaveBeenCalled();
    expect(createVerificationSubmission).not.toHaveBeenCalled();
  });

  it("draws the upload budget before a documents request", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    assertUploadUrlAllowed.mockResolvedValue(null);
    createVerificationSubmission.mockResolvedValue({ submissionId: "sub_2", documents: [] });

    const allowed = await send({ documents: DOCUMENTS });

    expect(allowed.status).toBe(201);
    expect(assertUploadUrlAllowed).toHaveBeenCalledOnce();
    expect(createVerificationSubmission).toHaveBeenCalledOnce();
    expect(assertUploadUrlAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      createVerificationSubmission.mock.invocationCallOrder[0]!,
    );

    vi.clearAllMocks();
    requireSessionRole.mockResolvedValue(recruiterSession);
    const limitedResponse = NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
    assertUploadUrlAllowed.mockResolvedValue(limitedResponse);

    const limited = await send({ documents: DOCUMENTS });

    expect(limited).toBe(limitedResponse);
    expect(createVerificationSubmission).not.toHaveBeenCalled();
  });

  it("answers a closure refusal with its cause", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    createInstagramTickRequest.mockRejectedValue(
      new SubmissionError(
        "institution_tick_closed_needs_documents",
        409,
        "This workspace's tick was removed by staff or by a name proof rule, so it can only return through documents",
        { cause: "automatic", closedInstitutionId: "inst_1" },
      ),
    );

    const response = await send({
      path: "instagram",
      instagramUrl: "https://instagram.com/acme.org",
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.details.cause).toBe("automatic");
  });
});
