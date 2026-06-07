// @vitest-environment node
//
// Step 6.5f — post-publish edit (F6/F17) and unpublish-as-cancellation (F6) integration tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitionRow } from "@/server/competitions/competition-access";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";

const {
  assertCompetitionAccess,
  enqueueCompetitionEdited,
  enqueueCompetitionCancelled,
  enqueueCompetitionSearchSync,
} = vi.hoisted(() => ({
  assertCompetitionAccess: vi.fn(),
  enqueueCompetitionEdited: vi.fn(),
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
  enqueueCompetitionEdited,
  enqueueCompetitionCancelled,
  enqueueCompetitionSearchSync,
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
  category: "technology",
  mode: "both",
  minTeamSize: 1,
  maxTeamSize: 4,
  registrationStartAt: new Date(Date.now() + 5 * DAY),
  registrationEndAt: new Date(Date.now() + 20 * DAY),
  eventStartAt: new Date(Date.now() + 60 * DAY),
  eventEndAt: new Date(Date.now() + 61 * DAY),
  allowCancellation: false,
  cancellationCutoffDays: null,
  publishedAt: new Date(),
  archivedAt: null,
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

beforeEach(() => {
  enqueueCompetitionEdited.mockResolvedValue({});
  enqueueCompetitionCancelled.mockResolvedValue({});
  enqueueCompetitionSearchSync.mockResolvedValue({});
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
        eventStartAt: new Date(Date.now() + 30 * DAY),
      }),
      membershipRole: "institution_owner",
    });
    // One active registration; pulling the event to 3 days out closes the cancel window retroactively.
    const db = { select: () => selectChain([{ registrationType: "individual", teamId: null }]) } as unknown as Database;

    await expect(
      updateCompetitionDraft(
        "u_1",
        "comp_1",
        { eventStartAt: new Date(Date.now() + 3 * DAY) },
        db,
      ),
    ).rejects.toMatchObject({
      code: "competition_post_publish_blocked",
      httpStatus: 422,
      details: { blockedFields: expect.arrayContaining(["eventStartAt"]) },
    });
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
});

describe("unpublishCompetition — cascade", () => {
  it("transitions to draft, cancels all non-cancelled registrations, and enqueues after commit", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published" }),
      membershipRole: "institution_owner",
    });

    const setSpy = vi.fn();
    const draftRow = baseCompetition({ status: "draft" });
    const statusUpdate = updateChain([draftRow]);
    const cancelUpdate = updateChain([{ id: "r1" }, { id: "r2" }, { id: "r3" }], setSpy);
    let call = 0;
    const tx = {
      update: () => {
        call += 1;
        return call === 1 ? statusUpdate : cancelUpdate;
      },
    };
    const db = {
      transaction: (cb: (tx: unknown) => unknown) => cb(tx),
    } as unknown as Database;

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
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "archived" }),
      membershipRole: "institution_owner",
    });
    const db = {
      transaction: vi.fn(),
    } as unknown as Database;

    await expect(unpublishCompetition("u_1", "comp_1", db)).rejects.toMatchObject({
      code: "competition_invalid_transition",
      httpStatus: 422,
    });
    expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
  });
});
