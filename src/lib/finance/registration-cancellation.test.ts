import { describe, expect, it } from "vitest";
import { wasWithdrawnByCandidate } from "./registration-cancellation";

describe("wasWithdrawnByCandidate", () => {
  it("is true for a cancelled registration with a reason the person typed", () => {
    expect(
      wasWithdrawnByCandidate({ status: "cancelled", cancellationReason: "Saya berhalangan" }),
    ).toBe(true);
  });

  it("is false for the reason the platform writes when the deadline passes", () => {
    expect(
      wasWithdrawnByCandidate({
        status: "cancelled",
        cancellationReason: "payment_deadline_expired",
      }),
    ).toBe(false);
  });

  it("is false for the reason written when the institution cancels the competition", () => {
    expect(
      wasWithdrawnByCandidate({
        status: "cancelled",
        cancellationReason: "competition_cancelled_by_institution",
      }),
    ).toBe(false);
  });

  it("is false for a cancelled registration with no reason", () => {
    expect(wasWithdrawnByCandidate({ status: "cancelled", cancellationReason: null })).toBe(false);
  });

  it("is false for a registration that is not cancelled, whatever its reason column holds", () => {
    expect(
      wasWithdrawnByCandidate({ status: "confirmed", cancellationReason: "Saya berhalangan" }),
    ).toBe(false);
  });
});
