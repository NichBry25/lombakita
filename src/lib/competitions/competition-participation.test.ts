import { describe, expect, it } from "vitest";
import {
  canCancelCompetitionForInsufficientParticipation,
  canConfirmCompetitionWillProceed,
  deriveCompetitionParticipationState,
  getCompetitionCancellationReasonLabel,
  isParticipantCancellationClosedByConfirmation,
  type CompetitionParticipationInput,
} from "./competition-participation";

const confirmationAt = new Date("2026-08-10T00:00:00.000Z");
const eventStartAt = new Date("2026-08-20T00:00:00.000Z");

const input = (
  overrides: Partial<CompetitionParticipationInput> = {},
): CompetitionParticipationInput => ({
  minimumParticipantEntries: 10,
  participantConfirmationAt: confirmationAt,
  participationConfirmedAt: null,
  eventStartAt,
  cancelledAt: null,
  participantEntryCount: 9,
  ...overrides,
});

describe("deriveCompetitionParticipationState", () => {
  it("returns not_configured when the minimum rule is absent", () => {
    expect(
      deriveCompetitionParticipationState(
        input({ minimumParticipantEntries: null, participantConfirmationAt: null }),
        confirmationAt,
      ),
    ).toBe("not_configured");
  });

  it("collects entries before the confirmation moment even when the current count is low", () => {
    expect(deriveCompetitionParticipationState(input(), new Date("2026-08-09T23:59:59.999Z"))).toBe(
      "collecting_entries",
    );
  });

  it("becomes confirmed at the confirmation moment when the minimum is met", () => {
    expect(
      deriveCompetitionParticipationState(input({ participantEntryCount: 10 }), confirmationAt),
    ).toBe("confirmed");
  });

  it("requires a decision at the confirmation moment when the minimum is unmet", () => {
    expect(deriveCompetitionParticipationState(input(), confirmationAt)).toBe("decision_due");
  });

  it("stays confirmed after an organizer commits to proceed below the minimum", () => {
    expect(
      deriveCompetitionParticipationState(
        input({ participationConfirmedAt: confirmationAt }),
        new Date("2026-08-11T00:00:00.000Z"),
      ),
    ).toBe("confirmed");
  });

  it("treats an uncancelled competition as proceeding once the event starts", () => {
    expect(deriveCompetitionParticipationState(input(), eventStartAt)).toBe("confirmed");
  });

  it("gives terminal cancellation precedence over every other state", () => {
    expect(
      deriveCompetitionParticipationState(
        input({
          cancelledAt: confirmationAt,
          participationConfirmedAt: confirmationAt,
          participantEntryCount: 12,
        }),
        eventStartAt,
      ),
    ).toBe("cancelled");
  });
});

describe("participation decision availability", () => {
  it("offers both organizer decisions only while the minimum is unmet and the event has not begun", () => {
    expect(canCancelCompetitionForInsufficientParticipation(input(), confirmationAt)).toBe(true);
    expect(canConfirmCompetitionWillProceed(input(), confirmationAt)).toBe(true);
  });

  it("offers neither decision once the minimum is met", () => {
    const met = input({ participantEntryCount: 10 });
    expect(canCancelCompetitionForInsufficientParticipation(met, confirmationAt)).toBe(false);
    expect(canConfirmCompetitionWillProceed(met, confirmationAt)).toBe(false);
  });
});

describe("participant cancellation cutoff", () => {
  it("closes at the exact confirmation moment", () => {
    expect(
      isParticipantCancellationClosedByConfirmation(
        confirmationAt,
        new Date("2026-08-09T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(isParticipantCancellationClosedByConfirmation(confirmationAt, confirmationAt)).toBe(
      true,
    );
  });
});

it("maps the stored cancellation reason to public copy", () => {
  expect(getCompetitionCancellationReasonLabel("insufficient_participants")).toBe(
    "Minimum peserta tidak tercapai.",
  );
  expect(getCompetitionCancellationReasonLabel("anything_else")).toBeNull();
});
