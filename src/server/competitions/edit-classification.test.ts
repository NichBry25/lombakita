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
  hasPaymentInFlight: false,
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

  it("notifies (not blocks) a narrowing mode change when no affected registrations exist", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "both" }),
      base({ mode: "team" }),
      snapshot({ nonCancelledCount: 0 }),
      NOW,
    );
    expect(result.notify).toContain("mode");
    expect(result.blocked).not.toContain("mode");
  });

  it("notifies a widening mode change (individual → both) regardless of registrations", () => {
    const result = classifyCompetitionEdit(
      base({ mode: "individual" }),
      base({ mode: "both" }),
      snapshot({ nonCancelledCount: 1, hasActiveIndividual: true }),
      NOW,
    );
    expect(result.notify).toContain("mode");
    expect(result.blocked).not.toContain("mode");
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
      base({ feeAmount: "0" }),
      base({ feeAmount: "50000" }),
      snapshot({ nonCancelledCount: 1, hasActiveFree: true }),
      NOW,
    );
    expect(result.blocked).toContain("feeAmount");
  });

  it("notifies a fee change when no free registrations are stranded", () => {
    const result = classifyCompetitionEdit(
      base({ feeAmount: "0" }),
      base({ feeAmount: "50000" }),
      snapshot({ nonCancelledCount: 0, hasActiveFree: false }),
      NOW,
    );
    expect(result.notify).toContain("feeAmount");
    expect(result.blocked).not.toContain("feeAmount");
  });

  it("does not classify fee when it is omitted on either side", () => {
    const result = classifyCompetitionEdit(base(), base({ title: "Lomba Baru" }), snapshot(), NOW);
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

  it("notifies moving eventStartAt earlier when the window still holds", () => {
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
    expect(result.notify).toContain("eventStartAt");
    expect(result.blocked).not.toContain("eventStartAt");
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
  it("a trivial-only edit returns an empty notify and blocked list", () => {
    const result = classifyCompetitionEdit(
      base(),
      base({ description: "Deskripsi baru" }),
      snapshot({ nonCancelledCount: 2 }),
      NOW,
    );
    expect(result.trivial).toEqual(["description"]);
    expect(result.notify).toEqual([]);
    expect(result.blocked).toEqual([]);
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
  // owed a message about, so it must never be classified as trivial.
  it("notifies when the result announcement date moves", () => {
    const result = classifyCompetitionEdit(
      base({ resultAnnouncementAt: new Date("2026-08-09T00:00:00.000Z") }),
      base({ resultAnnouncementAt: new Date("2026-09-09T00:00:00.000Z") }),
      snapshot({ nonCancelledCount: 2 }),
      NOW,
    );
    expect(result.notify).toContain("resultAnnouncementAt");
    expect(result.blocked).toEqual([]);
    expect(result.trivial).toEqual([]);
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

  it("no changes returns three empty lists", () => {
    const result = classifyCompetitionEdit(base(), base(), snapshot(), NOW);
    expect(result).toEqual({ blocked: [], notify: [], trivial: [] });
  });
});

describe("classifyCompetitionEdit — fee fields while money is in flight", () => {
  it("BLOCKS a fee change whenever a payment is in flight, in either direction", () => {
    // Someone has transferred real rupiah against the price they were shown. Moving that price
    // underneath them is the one fee edit no after-the-fact notification can make safe.
    const raise = classifyCompetitionEdit(
      base({ feeAmount: 50_000 }),
      base({ feeAmount: 75_000 }),
      snapshot({ hasPaymentInFlight: true }),
    );
    expect(raise.blocked).toContain("feeAmount");

    const lower = classifyCompetitionEdit(
      base({ feeAmount: 50_000 }),
      base({ feeAmount: 25_000 }),
      snapshot({ hasPaymentInFlight: true }),
    );
    expect(lower.blocked).toContain("feeAmount");
  });

  it("still only NOTIFIES on a fee change when nothing is in flight", () => {
    const result = classifyCompetitionEdit(
      base({ feeAmount: 50_000 }),
      base({ feeAmount: 75_000 }),
      snapshot({ hasPaymentInFlight: false }),
    );

    expect(result.notify).toContain("feeAmount");
    expect(result.blocked).not.toContain("feeAmount");
  });

  it("keeps the pre-existing free→paid block, which is a different rule", () => {
    // This one protects registrations taken for free from acquiring a price retroactively, and is
    // true even when nothing is in flight.
    const result = classifyCompetitionEdit(
      base({ feeAmount: 0 }),
      base({ feeAmount: 50_000 }),
      snapshot({ hasActiveFree: true, hasPaymentInFlight: false }),
    );

    expect(result.blocked).toContain("feeAmount");
  });

  it("classifies feeCurrency, which was previously not classified at all", () => {
    // An amount without its currency is not a price, so changing IDR to anything else restates what
    // the payer owes exactly as surely as changing the number.
    const blocked = classifyCompetitionEdit(
      base({ feeCurrency: "IDR" }),
      base({ feeCurrency: "USD" }),
      snapshot({ hasPaymentInFlight: true }),
    );
    expect(blocked.blocked).toContain("feeCurrency");

    const notified = classifyCompetitionEdit(
      base({ feeCurrency: "IDR" }),
      base({ feeCurrency: "USD" }),
      snapshot({ hasPaymentInFlight: false }),
    );
    expect(notified.notify).toContain("feeCurrency");
  });

  it("classifies paymentWindowDays as NOTIFY, never blocked", () => {
    // Shortening the window cannot harm anyone already paying: the deadline is snapshotted per
    // payment and never recomputed, so an existing pending payment keeps what it was given.
    const result = classifyCompetitionEdit(
      base({ paymentWindowDays: 3 }),
      base({ paymentWindowDays: 1 }),
      snapshot({ hasPaymentInFlight: true }),
    );

    expect(result.notify).toContain("paymentWindowDays");
    expect(result.blocked).not.toContain("paymentWindowDays");
  });

  it("classifies nothing when a fee field is absent on either side", () => {
    const result = classifyCompetitionEdit(base({}), base({}), snapshot({}));

    expect(result.blocked).not.toContain("feeCurrency");
    expect(result.notify).not.toContain("feeCurrency");
    expect(result.notify).not.toContain("paymentWindowDays");
  });
});

