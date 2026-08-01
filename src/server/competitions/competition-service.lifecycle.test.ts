// @vitest-environment node
//
// Step 6.5f — post-publish edit (F6/F17) and unpublish-as-cancellation (F6) integration tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitionRow } from "@/server/competitions/competition-access";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";

const {
  assertCompetitionAccess,
  hasActiveRegistrationsForCompetition,
  enqueueCompetitionEdited,
  enqueueCompetitionCancelled,
  enqueueCompetitionSearchSync,
} = vi.hoisted(() => ({
  assertCompetitionAccess: vi.fn(),
  hasActiveRegistrationsForCompetition: vi.fn(),
  enqueueCompetitionEdited: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));

vi.mock("@/server/competitions/competition-access", async () => {
  const actual = await vi.importActual<typeof import("@/server/competitions/competition-access")>(
    "@/server/competitions/competition-access",
  );
  return { ...actual, assertCompetitionAccess, hasActiveRegistrationsForCompetition };
});

vi.mock("@/server/async/enqueue", () => ({
  enqueueCompetitionEdited,
  enqueueCompetitionCancelled,
  enqueueCompetitionSearchSync,
}));
vi.mock("@/server/competitions/competition-participation-lock", () => ({
  acquireCompetitionParticipationLock: vi.fn(),
}));

import type { Database } from "@/server/db/client";
import {
  updateCompetitionDraft,
  unpublishCompetition,
} from "@/server/competitions/competition-service";

const DAY = 24 * 60 * 60 * 1000;

const baseCompetition = (overrides: Partial<CompetitionRow> = {}): CompetitionRow => ({
  id: "comp_1",
  institutionId: "inst_1",
  createdByUserId: "user_1",
  slug: "lomba",
  title: "Lomba",
  description: "Deskripsi",
  status: "published",
  category: "hackathon",
  mode: "both",
  minTeamSize: 1,
  maxTeamSize: 4,
  registrationStartAt: new Date(Date.now() + 5 * DAY),
  registrationEndAt: new Date(Date.now() + 20 * DAY),
  eventStartAt: new Date(Date.now() + 60 * DAY),
  eventEndAt: new Date(Date.now() + 61 * DAY),
  resultAnnouncementAt: new Date(Date.now() + 65 * DAY),
  minimumParticipantEntries: 0,
  participantConfirmationAt: new Date(Date.now() + 30 * DAY),
  participationConfirmedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  allowCancellation: false,
  cancellationCutoffDays: null,
  publishedAt: new Date(),
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// Select chain whose where() resolves to the snapshot rows (loadEditClassificationSnapshot).
const selectChain = (rows: unknown[]) => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => Promise.resolve(rows),
    limit: () => Promise.resolve(rows),
  };
  return chain;
};

const updateChain = (returningRows: unknown[], setSpy?: (vals: unknown) => void) => ({
  set: (vals: unknown) => {
    setSpy?.(vals);
    return { where: () => ({ returning: () => Promise.resolve(returningRows) }) };
  },
});

const lockedSelectChain = (rows: unknown[]) => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
};

const makeUnpublishDb = (
  currentCompetition: CompetitionRow,
  options: {
    statusRows?: unknown[];
    cancelledRows?: unknown[];
    cancellationSetSpy?: (values: unknown) => void;
  } = {},
): Database => {
  let updateCall = 0;
  const tx = {
    select: () => lockedSelectChain([currentCompetition]),
    update: () => {
      updateCall += 1;
      return updateCall === 1
        ? updateChain(
            options.statusRows ?? [baseCompetition({ ...currentCompetition, status: "draft" })],
          )
        : updateChain(options.cancelledRows ?? [], options.cancellationSetSpy);
    },
  };
  return {
    transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
  } as unknown as Database;
};

beforeEach(() => {
  enqueueCompetitionEdited.mockResolvedValue({});
  enqueueCompetitionCancelled.mockResolvedValue({});
  enqueueCompetitionSearchSync.mockResolvedValue({});
  hasActiveRegistrationsForCompetition.mockResolvedValue(false);
});

afterEach(() => vi.clearAllMocks());

describe("updateCompetitionDraft — draft path unchanged", () => {
  it("persists a draft edit and does not enqueue competition.edited", async () => {
    const updated = baseCompetition({ status: "draft", title: "Judul Baru" });
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "draft" }),
      membershipRole: "institution_owner",
    });
    const db = { update: () => updateChain([updated]) } as unknown as Database;

    const result = await updateCompetitionDraft("u_1", "comp_1", { title: "Judul Baru" }, db);
    expect(result.title).toBe("Judul Baru");
    expect(enqueueCompetitionEdited).not.toHaveBeenCalled();
  });
});

describe("updateCompetitionDraft — published edit (F6/F17)", () => {
  it("returns 422 competition_post_publish_blocked when a blocked field is touched", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({
        status: "published",
        allowCancellation: true,
        cancellationCutoffDays: 7,
        registrationStartAt: new Date(Date.now() + DAY),
        registrationEndAt: new Date(Date.now() + 2 * DAY),
        eventStartAt: new Date(Date.now() + 30 * DAY),
        participantConfirmationAt: new Date(Date.now() + 2.5 * DAY),
      }),
      membershipRole: "institution_owner",
    });
    // One active registration; pulling the event to 3 days out closes the cancel window retroactively.
    const db = {
      select: () => selectChain([{ registrationType: "individual", teamId: null }]),
    } as unknown as Database;

    await expect(
      updateCompetitionDraft("u_1", "comp_1", { eventStartAt: new Date(Date.now() + 3 * DAY) }, db),
    ).rejects.toMatchObject({
      code: "competition_post_publish_blocked",
      httpStatus: 422,
      details: { blockedFields: expect.arrayContaining(["eventStartAt"]) },
    });
  });

  // A published competition's post-event lifecycle is measured from eventEndAt — when results
  // become due, and when its documents are purged. Clearing it would drop the competition out of
  // both windows, so the edit is refused rather than classified.
  it("refuses to clear eventEndAt on a published competition", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published" }),
      membershipRole: "institution_owner",
    });
    const db = { select: () => selectChain([]) } as unknown as Database;

    await expect(
      updateCompetitionDraft("u_1", "comp_1", { eventEndAt: null }, db),
    ).rejects.toMatchObject({
      code: "competition_publish_validation_failed",
      httpStatus: 422,
      details: { fields: expect.arrayContaining(["eventEndAt"]) },
    });
  });

  it("refuses to clear category on a published competition", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published" }),
      membershipRole: "institution_owner",
    });
    const db = { select: () => selectChain([]) } as unknown as Database;

    await expect(
      updateCompetitionDraft("u_1", "comp_1", { category: null }, db),
    ).rejects.toMatchObject({
      code: "competition_publish_validation_failed",
      httpStatus: 422,
    });
  });

  // The presence guard must not drag the publish-time future-date rule along with it: a finished
  // competition's registration deadline is necessarily in the past, and it must stay editable.
  it("still allows editing a competition whose registration deadline has passed", async () => {
    const past = baseCompetition({
      status: "published",
      registrationStartAt: new Date(Date.now() - 40 * DAY),
      registrationEndAt: new Date(Date.now() - 30 * DAY),
      eventStartAt: new Date(Date.now() - 20 * DAY),
      eventEndAt: new Date(Date.now() - 19 * DAY),
      participantConfirmationAt: new Date(Date.now() - 25 * DAY),
    });
    const updated = { ...past, description: "Ringkasan pemenang" };
    assertCompetitionAccess.mockResolvedValue({
      competition: past,
      membershipRole: "institution_owner",
    });
    const db = {
      select: () => selectChain([]),
      update: () => updateChain([updated]),
    } as unknown as Database;

    const result = await updateCompetitionDraft(
      "u_1",
      "comp_1",
      { description: "Ringkasan pemenang" },
      db,
    );
    expect(result.description).toBe("Ringkasan pemenang");
  });

  it("persists a notify-bucket edit and enqueues exactly one competition.edited", async () => {
    const updated = baseCompetition({ status: "published", title: "Judul Baru" });
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published" }),
      membershipRole: "institution_owner",
    });
    const db = {
      select: () => selectChain([]),
      update: () => updateChain([updated]),
    } as unknown as Database;

    const result = await updateCompetitionDraft("u_1", "comp_1", { title: "Judul Baru" }, db);

    expect(result.title).toBe("Judul Baru");
    expect(enqueueCompetitionEdited).toHaveBeenCalledOnce();
    expect(enqueueCompetitionEdited).toHaveBeenCalledWith(
      expect.objectContaining({
        competitionId: "comp_1",
        changedFields: expect.arrayContaining(["title"]),
      }),
    );
  });

  it("persists a trivial-only edit and does NOT enqueue", async () => {
    const updated = baseCompetition({ status: "published", description: "Deskripsi baru" });
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published" }),
      membershipRole: "institution_owner",
    });
    const db = {
      select: () => selectChain([]),
      update: () => updateChain([updated]),
    } as unknown as Database;

    await updateCompetitionDraft("u_1", "comp_1", { description: "Deskripsi baru" }, db);
    expect(enqueueCompetitionEdited).not.toHaveBeenCalled();
  });

  it("returns 422 competition_field_immutable when an immutable field changes (outer layer)", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published", mode: "individual" }),
      membershipRole: "institution_owner",
    });
    const db = {} as unknown as Database;
    await expect(
      updateCompetitionDraft("u_1", "comp_1", { mode: "team" }, db),
    ).rejects.toMatchObject({ code: "competition_field_immutable", httpStatus: 422 });
    // Outer layer fires before the snapshot is read — no select/enqueue.
    expect(enqueueCompetitionEdited).not.toHaveBeenCalled();
  });

  it("keeps the published minimum and confirmation commitment immutable", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({
        minimumParticipantEntries: 10,
        participantConfirmationAt: new Date(Date.now() + 30 * DAY),
      }),
      membershipRole: "institution_owner",
    });
    const db = {} as unknown as Database;

    await expect(
      updateCompetitionDraft("u_1", "comp_1", { minimumParticipantEntries: 12 }, db),
    ).rejects.toMatchObject({
      code: "competition_field_immutable",
      details: { fields: ["minimumParticipantEntries"] },
    });
  });
});

describe("unpublishCompetition — cascade", () => {
  it("transitions to draft, cancels all non-cancelled registrations, and enqueues after commit", async () => {
    const publishedCompetition = baseCompetition({ status: "published" });
    assertCompetitionAccess.mockResolvedValue({
      competition: publishedCompetition,
      membershipRole: "institution_owner",
    });

    const setSpy = vi.fn();
    const draftRow = baseCompetition({ status: "draft" });
    const db = makeUnpublishDb(publishedCompetition, {
      statusRows: [draftRow],
      cancelledRows: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
      cancellationSetSpy: setSpy,
    });

    const result = await unpublishCompetition("u_1", "comp_1", db);

    expect(result.cancelledCount).toBe(3);
    expect(result.competition.status).toBe("draft");
    // The cancel UPDATE stamps the institution reason.
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        cancellationReason: INSTITUTION_CANCELLATION_REASON,
      }),
    );
    expect(enqueueCompetitionCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ competitionId: "comp_1" }),
    );
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledWith(
      expect.objectContaining({ competitionId: "comp_1", action: "remove" }),
    );
  });

  it("rejects unpublishing a non-published competition with 422", async () => {
    const archivedCompetition = baseCompetition({ status: "archived" });
    assertCompetitionAccess.mockResolvedValue({
      competition: archivedCompetition,
      membershipRole: "institution_owner",
    });
    const db = makeUnpublishDb(archivedCompetition);

    await expect(unpublishCompetition("u_1", "comp_1", db)).rejects.toMatchObject({
      code: "competition_invalid_transition",
      httpStatus: 422,
    });
    expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
  });

  it("keeps a terminally cancelled competition published", async () => {
    const cancelledCompetition = baseCompetition({
      status: "published",
      cancelledAt: new Date(),
      cancellationReason: "insufficient_participants",
    });
    assertCompetitionAccess.mockResolvedValue({
      competition: cancelledCompetition,
      membershipRole: "institution_owner",
    });
    const db = makeUnpublishDb(cancelledCompetition);

    await expect(unpublishCompetition("u_1", "comp_1", db)).rejects.toMatchObject({
      code: "competition_already_cancelled",
      httpStatus: 409,
    });
    expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
  });

  it("refuses withdrawal at participantConfirmationAt even before the event starts", async () => {
    const confirmationAt = new Date("2026-08-10T00:00:00.000Z");
    const competitionAtBoundary = baseCompetition({
      minimumParticipantEntries: 10,
      participantConfirmationAt: confirmationAt,
      eventStartAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    assertCompetitionAccess.mockResolvedValue({
      competition: competitionAtBoundary,
      membershipRole: "institution_owner",
    });
    const db = makeUnpublishDb(competitionAtBoundary);

    await expect(unpublishCompetition("u_1", "comp_1", db, confirmationAt)).rejects.toMatchObject({
      code: "competition_unpublish_blocked_after_participation_confirmation",
      httpStatus: 422,
    });
    expect(hasActiveRegistrationsForCompetition).not.toHaveBeenCalled();
    expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
  });

  it("refuses to unpublish a started competition that has registrations, before touching any", async () => {
    const startedCompetition = baseCompetition({
      status: "published",
      eventStartAt: new Date(Date.now() - 1 * DAY),
      eventEndAt: new Date(Date.now() + 1 * DAY),
    });
    assertCompetitionAccess.mockResolvedValue({
      competition: startedCompetition,
      membershipRole: "institution_owner",
    });
    hasActiveRegistrationsForCompetition.mockResolvedValue(true);
    const db = makeUnpublishDb(startedCompetition);

    await expect(unpublishCompetition("u_1", "comp_1", db)).rejects.toMatchObject({
      code: "competition_unpublish_blocked_after_start",
      httpStatus: 422,
    });
    // The transaction rolls back before either mutation.
    expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
  });

  // Inverted deliberately: an earlier cut of this rule reopened withdrawal once the event was
  // over. It does not — a finished competition with registrants keeps its public page, which is
  // the whole point of retiring archiving (DEC-0123).
  it("stays refused after the event has ended while registrations exist", async () => {
    const finishedCompetition = baseCompetition({
      status: "published",
      eventStartAt: new Date(Date.now() - 10 * DAY),
      eventEndAt: new Date(Date.now() - 2 * DAY),
    });
    assertCompetitionAccess.mockResolvedValue({
      competition: finishedCompetition,
      membershipRole: "institution_owner",
    });
    hasActiveRegistrationsForCompetition.mockResolvedValue(true);
    const db = makeUnpublishDb(finishedCompetition);

    await expect(unpublishCompetition("u_1", "comp_1", db)).rejects.toMatchObject({
      code: "competition_unpublish_blocked_after_start",
      httpStatus: 422,
    });
  });

  it("allows unpublishing a started competition when nobody is registered", async () => {
    const startedCompetition = baseCompetition({
      status: "published",
      eventStartAt: new Date(Date.now() - 1 * DAY),
      eventEndAt: new Date(Date.now() + 1 * DAY),
    });
    assertCompetitionAccess.mockResolvedValue({
      competition: startedCompetition,
      membershipRole: "institution_owner",
    });
    hasActiveRegistrationsForCompetition.mockResolvedValue(false);

    const db = makeUnpublishDb(startedCompetition);

    const result = await unpublishCompetition("u_1", "comp_1", db);
    expect(result.competition.status).toBe("draft");
    expect(result.cancelledCount).toBe(0);
  });

  it("does not query registrations at all when the event has not started", async () => {
    const upcomingCompetition = baseCompetition({ status: "published" });
    assertCompetitionAccess.mockResolvedValue({
      competition: upcomingCompetition,
      membershipRole: "institution_owner",
    });

    const db = makeUnpublishDb(upcomingCompetition, { cancelledRows: [{ id: "r1" }] });

    await unpublishCompetition("u_1", "comp_1", db);
    expect(hasActiveRegistrationsForCompetition).not.toHaveBeenCalled();
  });
});
