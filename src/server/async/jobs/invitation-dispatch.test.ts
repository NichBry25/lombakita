// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { sendInstitutionInvitationEmail } = vi.hoisted(() => ({
  sendInstitutionInvitationEmail: vi.fn(),
}));
vi.mock("@/server/institution-invitations/invitation-email", () => ({
  sendInstitutionInvitationEmail,
}));

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb }));

import { processInstitutionInvitationDispatchJob } from "@/server/async/jobs/institution-invitation-dispatch";

const makeDb = (row: unknown) => {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
};

const makeJob = (rawToken = "rawtok") =>
  ({ id: "job_1", data: { invitationId: "inv_1", rawToken } }) as never;

const baseRow = (status: string) => ({
  invitedEmail: "x@e.com",
  invitedRole: "institution_staff",
  status,
  expiresAt: new Date(Date.now() + 60_000),
  institutionDisplayName: "Univ",
});

afterEach(() => vi.clearAllMocks());

describe("processInstitutionInvitationDispatchJob — status-derived email mode", () => {
  it("sends a TARGETED email (no token) when status is pending", async () => {
    getDb.mockReturnValue(makeDb(baseRow("pending")));
    await processInstitutionInvitationDispatchJob(makeJob());
    expect(sendInstitutionInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "targeted", rawToken: undefined }),
    );
  });

  it("sends a CLAIM email (with token) when status is pending_claim", async () => {
    getDb.mockReturnValue(makeDb(baseRow("pending_claim")));
    await processInstitutionInvitationDispatchJob(makeJob("rawtok"));
    expect(sendInstitutionInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "claim", rawToken: "rawtok" }),
    );
  });

  it("skips a stale invitation (cancelled/accepted) without emailing", async () => {
    getDb.mockReturnValue(makeDb(baseRow("cancelled")));
    await processInstitutionInvitationDispatchJob(makeJob());
    expect(sendInstitutionInvitationEmail).not.toHaveBeenCalled();
  });

  it("skips when the invitation no longer exists", async () => {
    getDb.mockReturnValue(makeDb(null));
    await processInstitutionInvitationDispatchJob(makeJob());
    expect(sendInstitutionInvitationEmail).not.toHaveBeenCalled();
  });
});
