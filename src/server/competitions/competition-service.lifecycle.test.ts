// @vitest-environment node
//
// Post-publish edit and unpublish-as-cancellation, exercised through the service rather than
// against the classifier directly.

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

const { hasCompetitionPaymentInFlightMock, hasActiveFreeRegistrationsMock } = vi.hoisted(() => ({
  hasCompetitionPaymentInFlightMock: vi.fn().mockResolvedValue(false),
  hasActiveFreeRegistrationsMock: vi.fn().mockResolvedValue(false),
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

// The DEC-0132 in-flight guard, which unpublishCompetition and the edit classifier both consult.
// Defaulted to "nothing in flight" so the pre-existing lifecycle assertions keep testing what they
// were written to test; the guard's own behaviour, that it blocks and that the classifier blocks
// a fee edit behind it, is proven separately against a live Postgres.
vi.mock("@/server/finance/paid-registration", () => ({
  hasCompetitionPaymentInFlight: hasCompetitionPaymentInFlightMock,
  hasActiveFreeRegistrations: hasActiveFreeRegistrationsMock,
}));

// A pass-through spy on the classifier, so the tests below can read the input the SERVICE built and
// then classify against it. The classifier's fee rules were unreachable for as long as the service
// left those fields undefined, and a test that hand-builds the input cannot notice that: it proves
// the function and says nothing about the wiring.
const { classifySpy } = vi.hoisted(() => ({ classifySpy: vi.fn() }));

vi.mock("@/server/competitions/edit-classification", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/competitions/edit-classification")>(
      "@/server/competitions/edit-classification",
    );
  return {
    ...actual,
    classifyCompetitionEdit: (
      ...args: Parameters<typeof actual.classifyCompetitionEdit>
    ): ReturnType<typeof actual.classifyCompetitionEdit> => {
      classifySpy(...args);
      return actual.classifyCompetitionEdit(...args);
    },
  };
});

import type { Database } from "@/server/db/client";
import {
  classifyCompetitionEdit,
  type ClassifiableCompetition,
} from "@/server/competitions/edit-classification";
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

// The published-edit path issues its selects in a fixed order: the competition's pricing first
// (loadCompetitionPricing), then the registration snapshot (loadEditClassificationSnapshot). One
// result set per call, so the two cannot be handed each other's rows.
const makeSelectQueue = (resultSets: unknown[][]) => {
  let call = 0;
  return () => {
    const rows = resultSets[call] ?? resultSets[resultSets.length - 1] ?? [];
    call += 1;
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
};

const FREE_PRICING = { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 };

/** A db for the published-edit path: pricing first, then the snapshot rows the classifier reads. */
const publishedEditSelect = (snapshotRows: unknown[], pricing: unknown = FREE_PRICING) =>
  makeSelectQueue([[pricing], snapshotRows]);

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
  hasCompetitionPaymentInFlightMock.mockResolvedValue(false);
  hasActiveFreeRegistrationsMock.mockResolvedValue(false);
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
      select: publishedEditSelect([{ registrationType: "individual", teamId: null }]),
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
    const db = { select: publishedEditSelect([]) } as unknown as Database;

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
    const db = { select: publishedEditSelect([]) } as unknown as Database;

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
      select: publishedEditSelect([]),
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
      select: publishedEditSelect([]),
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
      select: publishedEditSelect([]),
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

describe("the classifier's fee rules are reachable from the service", () => {
  const PRICED = { feeAmount: 75_000, feeCurrency: "IDR", paymentWindowDays: 5 };

  /**
   * Runs a real published edit and returns the classifier input the SERVICE constructed.
   *
   * Every fee assertion below starts from this value rather than from a literal, which is what makes
   * them tests of the wiring. Dropping a field from `toClassifiable` fails them all.
   */
  const captureClassifierInput = async (
    pricing: unknown = PRICED,
  ): Promise<ClassifiableCompetition> => {
    const published = baseCompetition({ status: "published" });
    const updated = baseCompetition({ status: "published", title: "Judul Baru" });
    assertCompetitionAccess.mockResolvedValue({
      competition: published,
      membershipRole: "institution_owner",
    });
    const db = {
      select: publishedEditSelect([], pricing),
      update: () => updateChain([updated]),
    } as unknown as Database;

    await updateCompetitionDraft("u_1", "comp_1", { title: "Judul Baru" }, db);

    expect(classifySpy).toHaveBeenCalled();
    return classifySpy.mock.calls[0]![0] as ClassifiableCompetition;
  };

  it("hands the classifier the competition's real pricing, not undefined", async () => {
    // The defect this pins: while these three were absent the classifier's fee branches could not
    // fire at all, so the free→paid block had never once run since it was written and its unit tests
    // passed throughout on hand-built objects.
    const input = await captureClassifierInput();

    expect(input.feeAmount).toBe(75_000);
    expect(input.feeCurrency).toBe("IDR");
    expect(input.paymentWindowDays).toBe(5);
  });

  it("blocks free → paid against active free registrations, on service-built input", async () => {
    const free = await captureClassifierInput({
      feeAmount: null,
      feeCurrency: null,
      paymentWindowDays: 3,
    });

    const result = classifyCompetitionEdit(
      free,
      { ...free, feeAmount: 50_000, feeCurrency: "IDR" },
      {
        nonCancelledCount: 1,
        hasActiveIndividual: true,
        hasActiveTeam: false,
        activeTeamSizes: [],
        hasActiveFree: true,
        hasPaymentInFlight: false,
      },
    );

    expect(result.blocked).toContain("feeAmount");
  });

  it("blocks any fee or currency change while money is in flight, on service-built input", async () => {
    const priced = await captureClassifierInput();
    const inFlight = {
      nonCancelledCount: 1,
      hasActiveIndividual: true,
      hasActiveTeam: false,
      activeTeamSizes: [],
      hasActiveFree: false,
      hasPaymentInFlight: true,
    };

    expect(
      classifyCompetitionEdit(priced, { ...priced, feeAmount: 90_000 }, inFlight).blocked,
    ).toContain("feeAmount");
    expect(
      classifyCompetitionEdit(priced, { ...priced, feeCurrency: "USD" }, inFlight).blocked,
    ).toContain("feeCurrency");
    expect(
      classifyCompetitionEdit(priced, { ...priced, registrationEndAt: new Date(0) }, inFlight)
        .blocked,
    ).toContain("registrationEndAt");
  });

  it("notifies a payment-window change, on service-built input", async () => {
    const priced = await captureClassifierInput();

    const result = classifyCompetitionEdit(priced, { ...priced, paymentWindowDays: 1 }, {
      nonCancelledCount: 0,
      hasActiveIndividual: false,
      hasActiveTeam: false,
      activeTeamSizes: [],
      hasActiveFree: false,
      hasPaymentInFlight: true,
    });

    expect(result.notify).toContain("paymentWindowDays");
    expect(result.blocked).not.toContain("paymentWindowDays");
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
