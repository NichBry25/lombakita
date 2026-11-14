// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  classifyCompetitionEdit,
  type ClassifiableCompetition,
  type EditClassificationSnapshot,
} from "./edit-classification";

const NOW = new Date("2026-05-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const base = (overrides: Partial<ClassifiableCompetition> = {}): ClassifiableCompetition => ({
  title: "Lomba",
  slug: "lomba",
  description: "Deskripsi",
  category: "hackathon",
  mode: "both",
  minTeamSize: 1,
  maxTeamSize: 4,
  registrationStartAt: new Date("2026-06-01T00:00:00.000Z"),
  registrationEndAt: new Date("2026-07-01T00:00:00.000Z"),
  eventStartAt: new Date("2026-08-01T00:00:00.000Z"),
  eventEndAt: new Date("2026-08-02T00:00:00.000Z"),
  resultAnnouncementAt: null,
  allowCancellation: false,
  cancellationCutoffDays: null,
  feeAmount: null,
  feeCurrency: null,
  paymentWindowDays: 3,
  ...overrides,
});

const snapshot = (
  overrides: Partial<EditClassificationSnapshot> = {},
): EditClassificationSnapshot => ({
  nonCancelledCount: 0,
  hasActiveIndividual: false,
  hasActiveTeam: false,
  activeTeamSizes: [],
  hasActiveFree: false,
  hasTransferAwaitingReview: false,
  ...overrides,
});

describe("classifyCompetitionEdit — mode changes", () => {
  it("blocks both → team when active individual registrations exist", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "both" }),
      base({ mode: "team" }),
      snapshot({ nonCancelledCount: 1, hasActiveIndividual: true }),
      NOW,
    );
    expect(result.blocked).toContain("mode");
    expect(result.notify).not.toContain("mode");
  });

  it("blocks both → individual when active team registrations exist", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "both" }),
      base({ mode: "individual" }),
      snapshot({ nonCancelledCount: 1, hasActiveTeam: true, activeTeamSizes: [3] }),
      NOW,
    );
    expect(result.blocked).toContain("mode");
  });

  it("blocks team → individual when active team registrations exist", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "team", minTeamSize: 2 }),
      base({ mode: "individual", minTeamSize: 2 }),
      snapshot({ nonCancelledCount: 1, hasActiveTeam: true, activeTeamSizes: [3] }),
      NOW,
    );
    expect(result.blocked).toContain("mode");
  });

  it("blocks individual → team when active individual registrations exist", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "individual" }),
      base({ mode: "team" }),
      snapshot({ nonCancelledCount: 1, hasActiveIndividual: true }),
      NOW,
    );
    expect(result.blocked).toContain("mode");
  });

  it("blocks a narrowing mode change when no registration exists", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "both" }),
      base({ mode: "team" }),
      snapshot({ nonCancelledCount: 0 }),
      NOW,
    );
    expect(result.blocked).toContain("mode");
    expect(result.notify).not.toContain("mode");
  });

  it("blocks a widening mode change (individual → both) too", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "individual" }),
      base({ mode: "both" }),
      snapshot({ nonCancelledCount: 1, hasActiveIndividual: true }),
      NOW,
    );
    expect(result.blocked).toContain("mode");
    expect(result.notify).not.toContain("mode");
  });
});

describe("classifyCompetitionEdit — team size bounds", () => {
  it("blocks raising minTeamSize above an existing team's size", () => {
    const result = classifyCompetitionEdit(
      base({ minTeamSize: 2 }),
      base({ minTeamSize: 4 }),
      snapshot({ hasActiveTeam: true, activeTeamSizes: [3], nonCancelledCount: 3 }),
      NOW,
    );
    expect(result.blocked).toContain("minTeamSize");
  });

  it("blocks lowering maxTeamSize below an existing team's size", () => {
    const result = classifyCompetitionEdit(
      base({ maxTeamSize: 5 }),
      base({ maxTeamSize: 3 }),
      snapshot({ hasActiveTeam: true, activeTeamSizes: [4], nonCancelledCount: 4 }),
      NOW,
    );
    expect(result.blocked).toContain("maxTeamSize");
  });

  it("notifies a widening maxTeamSize change", () => {
    const result = classifyCompetitionEdit(
      base({ maxTeamSize: 4 }),
      base({ maxTeamSize: 6 }),
      snapshot({ hasActiveTeam: true, activeTeamSizes: [4], nonCancelledCount: 4 }),
      NOW,
    );
    expect(result.notify).toContain("maxTeamSize");
    expect(result.blocked).not.toContain("maxTeamSize");
  });
});

describe("classifyCompetitionEdit — fee", () => {
  it("blocks 0 → positive fee when active free registrations exist", () => {
    const result = classifyCompetitionEdit(
      base({ feeAmount: 0 }),
      base({ feeAmount: 50_000 }),
      snapshot({ nonCancelledCount: 1, hasActiveFree: true }),
      NOW,
    );
    expect(result.blocked).toContain("feeAmount");
  });

  it("blocks a fee change when no free registration is stranded", () => {
    const result = classifyCompetitionEdit(
      base({ feeAmount: 0 }),
      base({ feeAmount: 50_000 }),
      snapshot({ nonCancelledCount: 0, hasActiveFree: false }),
      NOW,
    );
    expect(result.blocked).toContain("feeAmount");
    expect(result.notify).not.toContain("feeAmount");
  });

  it("treats NULL and 0 as the same free price rather than as a change", () => {
    // The column stores both, and a competition moving between them has not changed its price.
    const result = classifyCompetitionEdit(
      base({ feeAmount: null }),
      base({ feeAmount: 0 }),
      snapshot({ hasActiveFree: true }),
      NOW,
    );
    expect(result.blocked).not.toContain("feeAmount");
    expect(result.notify).not.toContain("feeAmount");
  });
});

describe("classifyCompetitionEdit — eventStartAt cancel window", () => {
  it("blocks moving eventStartAt earlier so the cutoff lands in the past", () => {
    // cutoff 7 days; new event 3 days from NOW → window end is in the past.
    const oldRow = base({
      eventStartAt: new Date(NOW.getTime() + 30 * DAY),
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const newRow = base({
      eventStartAt: new Date(NOW.getTime() + 3 * DAY),
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot({ nonCancelledCount: 1 }), NOW);
    expect(result.blocked).toContain("eventStartAt");
  });

  it("blocks moving eventStartAt earlier even when the window still holds", () => {
    const oldRow = base({
      eventStartAt: new Date(NOW.getTime() + 60 * DAY),
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const newRow = base({
      eventStartAt: new Date(NOW.getTime() + 30 * DAY),
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot({ nonCancelledCount: 1 }), NOW);
    expect(result.blocked).toContain("eventStartAt");
    expect(result.notify).not.toContain("eventStartAt");
  });

  it("notifies pushing a not-yet-started eventStartAt later", () => {
    const oldRow = base({
      eventStartAt: new Date(NOW.getTime() + 10 * DAY),
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const newRow = base({
      eventStartAt: new Date(NOW.getTime() + 90 * DAY),
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot({ nonCancelledCount: 1 }), NOW);
    expect(result.notify).toContain("eventStartAt");
    expect(result.blocked).not.toContain("eventStartAt");
  });
});

describe("classifyCompetitionEdit — eventStartAt frozen once passed", () => {
  it("blocks pushing a started event's start date into the future", () => {
    // The bypass this closes: moving the start forward would make the competition read as
    // not-yet-started and reopen withdrawal, letting an organizer cancel every registration.
    const oldRow = base({ eventStartAt: new Date(NOW.getTime() - 1 * DAY) });
    const newRow = base({ eventStartAt: new Date(NOW.getTime() + 30 * DAY) });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot({ nonCancelledCount: 1 }), NOW);
    expect(result.blocked).toContain("eventStartAt");
    expect(result.notify).not.toContain("eventStartAt");
  });

  it("blocks moving a started event's start date earlier as well", () => {
    const oldRow = base({ eventStartAt: new Date(NOW.getTime() - 1 * DAY) });
    const newRow = base({ eventStartAt: new Date(NOW.getTime() - 10 * DAY) });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot(), NOW);
    expect(result.blocked).toContain("eventStartAt");
  });

  it("blocks regardless of whether anyone is registered", () => {
    const oldRow = base({ eventStartAt: new Date(NOW.getTime() - 1 * DAY) });
    const newRow = base({ eventStartAt: new Date(NOW.getTime() + 1 * DAY) });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot({ nonCancelledCount: 0 }), NOW);
    expect(result.blocked).toContain("eventStartAt");
  });

  it("leaves an unchanged started date out of every bucket", () => {
    const started = new Date(NOW.getTime() - 1 * DAY);
    const result = classifyCompetitionEdit(
      base({ eventStartAt: started }),
      base({ eventStartAt: new Date(started.getTime()) }),
      snapshot(),
      NOW,
    );
    expect(result.blocked).not.toContain("eventStartAt");
    expect(result.notify).not.toContain("eventStartAt");
  });

  it("blocks at the exact start instant", () => {
    const oldRow = base({ eventStartAt: new Date(NOW.getTime()) });
    const newRow = base({ eventStartAt: new Date(NOW.getTime() + 5 * DAY) });
    const result = classifyCompetitionEdit(oldRow, newRow, snapshot(), NOW);
    expect(result.blocked).toContain("eventStartAt");
  });
});

describe("classifyCompetitionEdit — buckets in isolation", () => {
  it("a description edit is announced", () => {
    const result = classifyCompetitionEdit(
      base(),
      base({ description: "Deskripsi baru" }),
      snapshot({ nonCancelledCount: 2 }),
      NOW,
    );
    expect(result).toEqual({ blocked: [], waitsForTransferReview: [], notify: ["description"] });
  });

  it("a notify-only edit returns an empty blocked list", () => {
    const result = classifyCompetitionEdit(
      base(),
      base({
        title: "Judul Baru",
        category: "business",
        allowCancellation: true,
        cancellationCutoffDays: 3,
      }),
      snapshot({ nonCancelledCount: 2 }),
      NOW,
    );
    expect(result.blocked).toEqual([]);
    expect(result.notify).toEqual(
      expect.arrayContaining(["title", "category", "allowCancellation", "cancellationCutoffDays"]),
    );
  });

  // Pushing back the date results were promised for is exactly what a waiting participant is
  // owed a message about, so it is always announced.
  it("notifies when the result announcement date moves", () => {
    const result = classifyCompetitionEdit(
      base({ resultAnnouncementAt: new Date("2026-08-09T00:00:00.000Z") }),
      base({ resultAnnouncementAt: new Date("2026-09-09T00:00:00.000Z") }),
      snapshot({ nonCancelledCount: 2 }),
      NOW,
    );
    expect(result.notify).toContain("resultAnnouncementAt");
    expect(result.blocked).toEqual([]);
  });

  it("notifies when a result announcement date is first set", () => {
    const result = classifyCompetitionEdit(
      base({ resultAnnouncementAt: null }),
      base({ resultAnnouncementAt: new Date("2026-08-09T00:00:00.000Z") }),
      snapshot({ nonCancelledCount: 1 }),
      NOW,
    );
    expect(result.notify).toContain("resultAnnouncementAt");
  });

  it("no changes returns two empty lists", () => {
    const result = classifyCompetitionEdit(base(), base(), snapshot(), NOW);
    expect(result).toEqual({ blocked: [], waitsForTransferReview: [], notify: [] });
  });
});

describe("classifyCompetitionEdit: fee fields while money is in flight", () => {
  it("BLOCKS a fee change whenever a payment is in flight, in either direction", () => {
    // Someone has transferred real rupiah against the price they were shown. Moving that price
    // underneath them is the one fee edit no after-the-fact notification can make safe.
    const raise = classifyCompetitionEdit(
      base({ feeAmount: 50_000 }),
      base({ feeAmount: 75_000 }),
      snapshot({ hasTransferAwaitingReview: true }),
    );
    expect(raise.blocked).toContain("feeAmount");

    const lower = classifyCompetitionEdit(
      base({ feeAmount: 50_000 }),
      base({ feeAmount: 25_000 }),
      snapshot({ hasTransferAwaitingReview: true }),
    );
    expect(lower.blocked).toContain("feeAmount");
  });

  it("BLOCKS a fee change when nothing is in flight too", () => {
    const result = classifyCompetitionEdit(
      base({ feeAmount: 50_000 }),
      base({ feeAmount: 75_000 }),
      snapshot({ hasTransferAwaitingReview: false }),
    );

    expect(result.blocked).toContain("feeAmount");
    expect(result.notify).not.toContain("feeAmount");
  });

  it("keeps the pre-existing free→paid block, which is a different rule", () => {
    // This one protects registrations taken for free from acquiring a price retroactively, and is
    // true even when nothing is in flight.
    const result = classifyCompetitionEdit(
      base({ feeAmount: 0 }),
      base({ feeAmount: 50_000 }),
      snapshot({ hasActiveFree: true, hasTransferAwaitingReview: false }),
    );

    expect(result.blocked).toContain("feeAmount");
  });

  it("BLOCKS a feeCurrency change whether or not a payment is in flight", () => {
    // An amount without its currency is not a price, so changing IDR to anything else restates what
    // the payer owes exactly as surely as changing the number.
    const blocked = classifyCompetitionEdit(
      base({ feeCurrency: "IDR" }),
      base({ feeCurrency: "USD" }),
      snapshot({ hasTransferAwaitingReview: true }),
    );
    expect(blocked.blocked).toContain("feeCurrency");

    const notInFlight = classifyCompetitionEdit(
      base({ feeCurrency: "IDR" }),
      base({ feeCurrency: "USD" }),
      snapshot({ hasTransferAwaitingReview: false }),
    );
    expect(notInFlight.blocked).toContain("feeCurrency");
  });

  it("classifies paymentWindowDays as NOTIFY, never blocked", () => {
    // Shortening the window cannot harm anyone already paying: the deadline is snapshotted per
    // payment and never recomputed, so an existing pending payment keeps what it was given.
    const result = classifyCompetitionEdit(
      base({ paymentWindowDays: 3 }),
      base({ paymentWindowDays: 1 }),
      snapshot({ hasTransferAwaitingReview: true }),
    );

    expect(result.notify).toContain("paymentWindowDays");
    expect(result.blocked).not.toContain("paymentWindowDays");
  });

  it("classifies nothing when no fee field changed", () => {
    const result = classifyCompetitionEdit(base({}), base({}), snapshot({}));

    expect(result.blocked).not.toContain("feeCurrency");
    expect(result.notify).not.toContain("feeCurrency");
    expect(result.notify).not.toContain("paymentWindowDays");
  });
});

describe("classifyCompetitionEdit: registrationEndAt while a transfer awaits verification", () => {
  it("BLOCKS moving the registration deadline while a transfer is outstanding", () => {
    // Each payment's own deadline is clamped to this date at creation and never recomputed. Moving
    // the date leaves an outstanding payment carrying a deadline derived from a date that no longer
    // exists, and nothing reconciles the two afterwards.
    const result = classifyCompetitionEdit(
      base({ registrationEndAt: new Date("2026-07-01T00:00:00.000Z") }),
      base({ registrationEndAt: new Date("2026-06-15T00:00:00.000Z") }),
      snapshot({ hasTransferAwaitingReview: true }),
      NOW,
    );

    expect(result.blocked).toContain("registrationEndAt");
    expect(result.notify).not.toContain("registrationEndAt");
  });

  it("holds a LATER deadline while a transfer awaits verification", () => {
    const result = classifyCompetitionEdit(
      base({ registrationEndAt: new Date("2026-07-01T00:00:00.000Z") }),
      base({ registrationEndAt: new Date("2026-09-01T00:00:00.000Z") }),
      snapshot({ hasTransferAwaitingReview: true }),
      NOW,
    );

    expect(result.waitsForTransferReview).toEqual(["registrationEndAt"]);
    expect(result.blocked).not.toContain("registrationEndAt");
  });

  it("BLOCKS an earlier deadline when nothing is in flight too", () => {
    const result = classifyCompetitionEdit(
      base({ registrationEndAt: new Date("2026-07-01T00:00:00.000Z") }),
      base({ registrationEndAt: new Date("2026-06-15T00:00:00.000Z") }),
      snapshot({ hasTransferAwaitingReview: false }),
      NOW,
    );

    expect(result.blocked).toContain("registrationEndAt");
    expect(result.notify).not.toContain("registrationEndAt");
  });
});

describe("classifyCompetitionEdit: what publishing locks", () => {
  it("blocks raising minTeamSize when no team is registered", () => {
    expect(
      classifyCompetitionEdit(
        base({ mode: "team", minTeamSize: 2 }),
        base({ mode: "team", minTeamSize: 3 }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: ["minTeamSize"], waitsForTransferReview: [], notify: [] });
  });

  it("notifies lowering minTeamSize", () => {
    expect(
      classifyCompetitionEdit(
        base({ mode: "team", minTeamSize: 3 }),
        base({ mode: "team", minTeamSize: 2 }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: [], waitsForTransferReview: [], notify: ["minTeamSize"] });
  });

  it("blocks lowering maxTeamSize when no team is registered", () => {
    expect(
      classifyCompetitionEdit(base({ maxTeamSize: 4 }), base({ maxTeamSize: 3 }), snapshot(), NOW),
    ).toEqual({ blocked: ["maxTeamSize"], waitsForTransferReview: [], notify: [] });
  });

  it("blocks a team size going to or from no value", () => {
    expect(
      classifyCompetitionEdit(
        base({ minTeamSize: 2, maxTeamSize: null }),
        base({ minTeamSize: null, maxTeamSize: 4 }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: ["minTeamSize", "maxTeamSize"], waitsForTransferReview: [], notify: [] });
  });

  it("notifies a later registration close when nothing is in flight", () => {
    expect(
      classifyCompetitionEdit(
        base({ registrationEndAt: new Date("2026-07-01T00:00:00.000Z") }),
        base({ registrationEndAt: new Date("2026-07-15T00:00:00.000Z") }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: [], waitsForTransferReview: [], notify: ["registrationEndAt"] });
  });

  it("blocks a changed slug", () => {
    expect(
      classifyCompetitionEdit(
        base({ slug: "lomba" }),
        base({ slug: "lomba-baru" }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: ["slug"], waitsForTransferReview: [], notify: [] });
  });

  it("blocks turning withdrawal off", () => {
    expect(
      classifyCompetitionEdit(
        base({ allowCancellation: true, cancellationCutoffDays: 3 }),
        base({ allowCancellation: false, cancellationCutoffDays: null }),
        snapshot(),
        NOW,
      ),
    ).toEqual({
      blocked: ["allowCancellation"],
      waitsForTransferReview: [],
      notify: ["cancellationCutoffDays"],
    });
  });

  it("blocks a larger cancellation cutoff", () => {
    expect(
      classifyCompetitionEdit(
        base({ allowCancellation: true, cancellationCutoffDays: 3 }),
        base({ allowCancellation: true, cancellationCutoffDays: 5 }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: ["cancellationCutoffDays"], waitsForTransferReview: [], notify: [] });
  });

  it("notifies a smaller cancellation cutoff", () => {
    expect(
      classifyCompetitionEdit(
        base({ allowCancellation: true, cancellationCutoffDays: 5 }),
        base({ allowCancellation: true, cancellationCutoffDays: 3 }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: [], waitsForTransferReview: [], notify: ["cancellationCutoffDays"] });
  });

  it("notifies an earlier event end before the event starts", () => {
    expect(
      classifyCompetitionEdit(
        base({ eventEndAt: new Date("2026-08-02T00:00:00.000Z") }),
        base({ eventEndAt: new Date("2026-08-01T12:00:00.000Z") }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: [], waitsForTransferReview: [], notify: ["eventEndAt"] });
  });

  it("blocks a first price on a free competition with no registration", () => {
    expect(
      classifyCompetitionEdit(
        base(),
        base({ feeAmount: 50_000, feeCurrency: "IDR" }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: ["feeAmount", "feeCurrency"], waitsForTransferReview: [], notify: [] });
  });

  it("blocks an earlier event end once the event has started", () => {
    expect(
      classifyCompetitionEdit(
        base({
          eventStartAt: new Date(NOW.getTime() - DAY),
          eventEndAt: new Date(NOW.getTime() + 2 * DAY),
        }),
        base({
          eventStartAt: new Date(NOW.getTime() - DAY),
          eventEndAt: new Date(NOW.getTime() + DAY),
        }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: ["eventEndAt"], waitsForTransferReview: [], notify: [] });
  });

  it("notifies a later event end after the event has started", () => {
    expect(
      classifyCompetitionEdit(
        base({
          eventStartAt: new Date(NOW.getTime() - DAY),
          eventEndAt: new Date(NOW.getTime() + 2 * DAY),
        }),
        base({
          eventStartAt: new Date(NOW.getTime() - DAY),
          eventEndAt: new Date(NOW.getTime() + 3 * DAY),
        }),
        snapshot(),
        NOW,
      ),
    ).toEqual({ blocked: [], waitsForTransferReview: [], notify: ["eventEndAt"] });
  });
});
