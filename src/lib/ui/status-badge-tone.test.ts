import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_BADGE_TONES, type StatusBadgeTone } from "@/lib/ui/status-badge-tone";
import { PAYMENT_STATUS_TONES } from "@/lib/finance/payment-display";
import { PROOF_STATUS_TONES } from "@/lib/finance/proof-display";

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * The `data-status` values that carry an actual COLOUR RULE on `.status-badge`.
 *
 * Two exclusions, and each was proven necessary by a probe rather than reasoned about:
 *
 * Selector-scoped, because a plain search for `data-status="eligible"` matches in this stylesheet
 * and would pass the value as valid, but that match belongs to `.eligibility-status-card`.
 *
 * Pseudo-element-excluded, because `.status-badge[data-status="paid"]::before` also matches a
 * class-anchored pattern. A first version of this helper accepted it, and deleting the colour rule
 * while leaving the dot rule kept the test green: the tone would have rendered as a bare grey pill
 * with a coloured dot, which is the defect this file exists to catch. `[^:]` after the bracket is
 * what makes the question "is this value styled" rather than "is this value mentioned".
 */
const tonesDefinedForStatusBadge = (): Set<string> => {
  const pattern = /\.status-badge\[data-status="([^"]+)"\][^:]/g;
  const found = new Set<string>();
  for (const match of CSS.matchAll(pattern)) found.add(match[1]!);
  return found;
};

/** The tones inside the `:is(...)` group that draws the leading dot. */
const tonesWithDot = (): Set<string> => {
  const group = /\.status-badge:is\(([\s\S]*?)\)::before/.exec(CSS);
  if (!group) return new Set();
  const found = new Set<string>();
  for (const match of group[1]!.matchAll(/\[data-status="([^"]+)"\]/g)) found.add(match[1]!);
  return found;
};

describe("the .status-badge tone vocabulary", () => {
  it("agrees with globals.css in BOTH directions", () => {
    // Both directions, because each catches a different mistake: a union value missing from the
    // stylesheet renders an unstyled pill, and a stylesheet value missing from the union is a tone
    // nobody can reach through the type.
    const inCss = tonesDefinedForStatusBadge();

    expect([...inCss].sort()).toEqual([...STATUS_BADGE_TONES].sort());
  });

  it("does NOT admit eligible/ineligible, which belong to a different component", () => {
    // The exact near-miss that shipped. Both strings appear in globals.css, so a substring search
    // clears them; both belong to `.eligibility-status-card` and `.team-eligibility`, and a
    // `.status-badge` carrying either renders grey and dotless.
    expect(CSS).toContain('[data-status="eligible"]');
    expect(tonesDefinedForStatusBadge().has("eligible")).toBe(false);
    expect(tonesDefinedForStatusBadge().has("ineligible")).toBe(false);
  });

  it("gives every tone but `featured` the leading dot its siblings have", () => {
    // `featured` is deliberately outside the dot group. It is a promotional marker rather than a
    // lifecycle state. Everything else must be in it, or one badge in a row renders visibly
    // lighter than the others for no reason a reader can see.
    const dotted = tonesWithDot();
    const expected = STATUS_BADGE_TONES.filter((tone) => tone !== "featured");

    expect([...dotted].sort()).toEqual([...expected].sort());
  });
});

describe("payment lane tone maps", () => {
  const assertEveryToneIsReal = (map: Record<string, StatusBadgeTone>, name: string) => {
    const inCss = tonesDefinedForStatusBadge();

    for (const [status, tone] of Object.entries(map)) {
      expect(
        inCss.has(tone),
        `${name}.${status} = "${tone}", which .status-badge does not style`,
      ).toBe(true);
    }
  };

  it("renders every payment display status with a tone the badge actually styles", () => {
    // This replaces a `toBeTruthy()` assertion that passed for any non-empty string, including the
    // three wrong values it was standing over.
    assertEveryToneIsReal(PAYMENT_STATUS_TONES, "PAYMENT_STATUS_TONES");
  });

  it("renders every proof review status with a tone the badge actually styles", () => {
    assertEveryToneIsReal(PROOF_STATUS_TONES, "PROOF_STATUS_TONES");
  });
});
