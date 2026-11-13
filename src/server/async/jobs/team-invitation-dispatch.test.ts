// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { sendTeamInvitationEmail } = vi.hoisted(() => ({
  sendTeamInvitationEmail: vi.fn(),
}));
vi.mock("@/server/teams/team-email", () => ({ sendTeamInvitationEmail }));

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb }));

import { processTeamInvitationDispatchJob } from "@/server/async/jobs/team-invitation-dispatch";

// The job's select joins teams and then competitions, so the chain has two inner joins.
const makeDb = (row: unknown) => {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const secondInnerJoin = vi.fn().mockReturnValue({ where });
  const firstInnerJoin = vi.fn().mockReturnValue({ innerJoin: secondInnerJoin });
  const from = vi.fn().mockReturnValue({ innerJoin: firstInnerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
};

const makeJob = () =>
  ({ id: "job_1", data: { invitationId: "inv_1", rawToken: "rawtok" } }) as never;

const baseRow = (teamStatus: string, competitionFeeAmount: number | null) => ({
  invitedEmail: "dewi@example.test",
  invitedByUserId: null,
  status: "pending",
  expiresAt: new Date(Date.now() + 60_000),
  teamName: "Tim Uji",
  competitionTitle: "Lomba Uji",
  teamStatus,
  competitionFeeAmount,
});

afterEach(() => vi.clearAllMocks());

describe("processTeamInvitationDispatchJob — what the email says about the team", () => {
  it("tells the email the team is registered when a free team has registered", async () => {
    getDb.mockReturnValue(makeDb(baseRow("submitted", null)));

    await processTeamInvitationDispatchJob(makeJob());

    expect(sendTeamInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ joinsRegisteredTeam: true, mode: "targeted" }),
    );
  });

  it("keeps the forming wording for a registered paid team", async () => {
    getDb.mockReturnValue(makeDb(baseRow("submitted", 150_000)));

    await processTeamInvitationDispatchJob(makeJob());

    expect(sendTeamInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ joinsRegisteredTeam: false }),
    );
  });

  it("keeps the forming wording for a forming team", async () => {
    getDb.mockReturnValue(makeDb(baseRow("forming", null)));

    await processTeamInvitationDispatchJob(makeJob());

    expect(sendTeamInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ joinsRegisteredTeam: false }),
    );
  });
});
