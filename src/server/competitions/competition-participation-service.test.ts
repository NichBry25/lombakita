// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CompetitionRow } from "@/server/competitions/competition-access";
import type { Database } from "@/server/db/client";
import { INSUFFICIENT_PARTICIPANTS_REASON } from "@/lib/competitions/competition-participation";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";

const { assertCompetitionAccess, enqueueCompetitionCancelled, enqueueCompetitionSearchSync } =
  vi.hoisted(() => ({
    assertCompetitionAccess: vi.fn(),
    enqueueCompetitionCancelled: vi.fn(),
    enqueueCompetitionSearchSync: vi.fn(),
  }));

vi.mock("@/server/competitions/competition-access", async () => {
  const actual = await vi.importActual<typeof import("@/server/competitions/competition-access")>(
    "@/server/competitions/competition-access",
  );
  return { ...actual, assertCompetitionAccess };
});

vi.mock("@/server/async/enqueue", () => ({
  enqueueCompetitionCancelled,
  enqueueCompetitionSearchSync,
}));
vi.mock("@/server/competitions/competition-participation-lock", () => ({
  acquireCompetitionParticipationLock: vi.fn(),
}));

import {
  cancelCompetitionForInsufficientParticipation,
  confirmCompetitionWillProceed,
  countCompetitionParticipantEntries,
  participantEntryCountSql,
} from "@/server/competitions/competition-participation-service";

const confirmationAt = new Date("2026-08-10T00:00:00.000Z");
const eventStartAt = new Date("2026-08-20T00:00:00.000Z");

const competition = (overrides: Partial<CompetitionRow> = {}): CompetitionRow => ({
  id: "comp_1",
  institutionId: "inst_1",
  createdByUserId: "owner_1",
  slug: "lomba",
  title: "Lomba",
  description: "Deskripsi",
  status: "published",
  category: "hackathon",
  mode: "both",
  minTeamSize: 1,
  maxTeamSize: 5,
  registrationStartAt: new Date("2026-07-01T00:00:00.000Z"),
  registrationEndAt: new Date("2026-08-01T00:00:00.000Z"),
  eventStartAt,
  eventEndAt: new Date("2026-08-21T00:00:00.000Z"),
  resultAnnouncementAt: null,
  minimumParticipantEntries: 10,
  participantConfirmationAt: confirmationAt,
  participationConfirmedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  allowCancellation: true,
  cancellationCutoffDays: 1,
  publishedAt: new Date("2026-07-01T00:00:00.000Z"),
  deletedAt: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  ...overrides,
});

const queuedSelect = (queue: unknown[][]) =>
  vi.fn(() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  });

const countDb = (count: number): Database =>
  ({ select: queuedSelect([[{ count }]]) }) as unknown as Database;

const updateChain = (rows: unknown[], setSpy?: ReturnType<typeof vi.fn>) => ({
  set: (values: unknown) => {
    setSpy?.(values);
    return {
      where: () => ({
        returning: () => Promise.resolve(rows),
      }),
    };
  },
});

const decisionDb = (count: number, updates: ReturnType<typeof updateChain>[] = []): Database => {
  const tx = {
    select: queuedSelect([[competition()], [{ count }]]),
    update: vi.fn(() => updates.shift() ?? updateChain([])),
  };
  return {
    transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
  } as unknown as Database;
};

beforeEach(() => {
  assertCompetitionAccess.mockResolvedValue({
    competition: competition(),
    membershipRole: "institution_owner",
  });
  enqueueCompetitionCancelled.mockResolvedValue({});
  enqueueCompetitionSearchSync.mockResolvedValue({});
});

afterEach(() => vi.clearAllMocks());

describe("countCompetitionParticipantEntries", () => {
  it("compiles the mode=both rule as individual rows plus distinct team entities", () => {
    const query = new PgDialect().sqlToQuery(participantEntryCountSql);

    expect(query.sql).toContain(
      'count(*) filter (where "competition_registrations"."registration_type" = \'individual\')',
    );
    expect(query.sql).toContain('count(distinct "competition_registrations"."team_id")');
    expect(query.sql).toContain(
      'filter (where "competition_registrations"."registration_type" = \'team\')',
    );
  });

  it("returns the database aggregate where individual rows and distinct teams are entry units", async () => {
    const db = countDb(10);
    await expect(countCompetitionParticipantEntries("comp_1", db)).resolves.toBe(10);
  });
});

describe("cancelCompetitionForInsufficientParticipation", () => {
  it("refuses before participantConfirmationAt", async () => {
    const db = decisionDb(3);

    await expect(
      cancelCompetitionForInsufficientParticipation(
        "owner_1",
        "comp_1",
        db,
        new Date("2026-08-09T23:59:59.999Z"),
      ),
    ).rejects.toMatchObject({
      code: "competition_participation_decision_unavailable",
      httpStatus: 409,
    });
    expect(assertCompetitionAccess).toHaveBeenCalledWith("owner_1", "comp_1", "admin", db);
  });

  it("refuses once the minimum is met at the confirmation moment", async () => {
    const db = decisionDb(10);

    await expect(
      cancelCompetitionForInsufficientParticipation("owner_1", "comp_1", db, confirmationAt),
    ).rejects.toMatchObject({
      code: "competition_participation_decision_unavailable",
      httpStatus: 409,
    });
  });

  it("keeps the competition published, records the reason, cancels registrations, and upserts search", async () => {
    const cancelledCompetition = competition({
      cancelledAt: confirmationAt,
      cancellationReason: INSUFFICIENT_PARTICIPANTS_REASON,
    });
    const competitionSet = vi.fn();
    const registrationSet = vi.fn();
    const db = decisionDb(9, [
      updateChain([cancelledCompetition], competitionSet),
      updateChain([{ id: "r1" }, { id: "r2" }], registrationSet),
    ]);

    const result = await cancelCompetitionForInsufficientParticipation(
      "owner_1",
      "comp_1",
      db,
      confirmationAt,
    );

    expect(result.competition.status).toBe("published");
    expect(result.cancelledRegistrationCount).toBe(2);
    expect(competitionSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelledAt: confirmationAt,
        cancellationReason: INSUFFICIENT_PARTICIPANTS_REASON,
      }),
    );
    expect(registrationSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        cancellationReason: INSTITUTION_CANCELLATION_REASON,
      }),
    );
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledWith({
      competitionId: "comp_1",
      action: "upsert",
    });
    expect(enqueueCompetitionCancelled).toHaveBeenCalledWith({
      competitionId: "comp_1",
      epoch: confirmationAt.getTime(),
    });
  });
});

describe("confirmCompetitionWillProceed", () => {
  it("records a terminal proceed decision below the minimum without cancelling registrations", async () => {
    const confirmed = competition({ participationConfirmedAt: confirmationAt });
    const setSpy = vi.fn();
    const db = decisionDb(9, [updateChain([confirmed], setSpy)]);

    const result = await confirmCompetitionWillProceed("owner_1", "comp_1", db, confirmationAt);

    expect(result.cancelledRegistrationCount).toBe(0);
    expect(result.competition.participationConfirmedAt).toEqual(confirmationAt);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ participationConfirmedAt: confirmationAt }),
    );
    expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
  });
});
