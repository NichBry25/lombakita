import { describe, expect, it } from "vitest";
import { shouldShowRegisterBar } from "./register-bar-rule";

const OPEN_FOR_A_CANDIDATE = {
  ctaState: "open",
  isCancelled: false,
  isSignedIn: true,
  isCandidate: true,
} as const;

describe("shouldShowRegisterBar", () => {
  it("shows for a candidate while registration is open", () => {
    expect(shouldShowRegisterBar(OPEN_FOR_A_CANDIDATE)).toBe(true);
  });

  it("shows for a signed-out visitor while registration is open", () => {
    expect(
      shouldShowRegisterBar({ ...OPEN_FOR_A_CANDIDATE, isSignedIn: false, isCandidate: false }),
    ).toBe(true);
  });

  it("does not show for a signed-in account that is not a candidate", () => {
    expect(shouldShowRegisterBar({ ...OPEN_FOR_A_CANDIDATE, isCandidate: false })).toBe(false);
  });

  it("does not show before registration opens or after it closes", () => {
    expect(shouldShowRegisterBar({ ...OPEN_FOR_A_CANDIDATE, ctaState: "not_yet_open" })).toBe(
      false,
    );
    expect(shouldShowRegisterBar({ ...OPEN_FOR_A_CANDIDATE, ctaState: "closed" })).toBe(false);
  });

  it("does not show for a cancelled competition", () => {
    expect(shouldShowRegisterBar({ ...OPEN_FOR_A_CANDIDATE, isCancelled: true })).toBe(false);
  });
});
