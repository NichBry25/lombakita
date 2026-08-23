/*
 * WHAT THE BROWSER AUDITS CAN FIND, AND HOW BAD EACH KIND OF FINDING IS.
 *
 * This table is the audits' declared subject. Every finding either names a class in it or the run
 * fails, so a new kind of finding cannot be added without saying here how its severity is measured
 * — which is the defect this closes. A key of the form `<page>|overflow` reported that a page had a
 * fault of some kind and nothing about the size of it, so a page allowlisted at 400px stayed
 * allowlisted at 900px under a green run. Four of the five classes below had that shape.
 *
 * EVERY MAGNITUDE IS HIGHER-IS-WORSE. Two of the underlying metrics are not — a contrast ratio and
 * a tone separation both get worse as they fall — so those classes store the DEFICIT against their
 * threshold rather than the reading. That keeps one comparison direction across every class, which
 * is what lets `classifyAgainstBaseline` hold a baselined finding to its recorded number without
 * knowing which class it belongs to. Storing the raw separation would have inverted the comparison
 * and passed every regression it exists to catch.
 *
 *   metric: "raw"     — the measurement is already higher-is-worse
 *   metric: "deficit" — the measurement is lower-is-worse, so the shortfall is stored, and a
 *                       reading exactly at the threshold is a magnitude of zero
 */

/** Two decimals, so a magnitude does not carry float noise into a committed baseline. */
const round2 = (value) => Math.round(value * 100) / 100;

export const FINDING_CLASSES = {
  overflow: {
    audit: "mobile-audit",
    describes: "the document scrolls sideways",
    unit: "px of document width",
    metric: "raw",
    magnitudeOf: ({ scrollWidth }) => scrollWidth,
    example: { measurement: { scrollWidth: 400 }, magnitude: 400 },
  },

  wide: {
    audit: "mobile-audit",
    describes: "an element sits past the viewport edge",
    unit: "px past the edge, in whichever direction it goes",
    metric: "raw",
    // A LEFT-overflowing element does not raise the document's scrollWidth, so the page-level
    // `overflow` finding cannot see it and this is the only number that measures it.
    magnitudeOf: ({ right, left, viewport }) => Math.round(Math.max(right - viewport, -left, 0)),
    example: { measurement: { right: 400, left: 0, viewport: 390 }, magnitude: 10 },
  },

  target: {
    audit: "mobile-audit",
    describes: "an interactive control is under the 44x44px minimum",
    unit: "px short of 44 on its smaller side",
    metric: "deficit",
    magnitudeOf: ({ width, height }) => 44 - Math.min(width, height),
    example: { measurement: { width: 40, height: 44 }, magnitude: 4 },
  },

  contrast: {
    audit: "contrast-audit",
    describes: "a text pairing is under its WCAG AA threshold",
    unit: "ratio points short of the threshold",
    metric: "deficit",
    magnitudeOf: ({ need, ratio }) => round2(need - ratio),
    example: { measurement: { need: 4.5, ratio: 3 }, magnitude: 1.5 },
  },

  tone: {
    audit: "contrast-audit",
    describes: "two semantic tones are too close to tell apart",
    unit: "ΔE2000 short of the separation threshold",
    metric: "deficit",
    magnitudeOf: ({ need, separation }) => round2(need - separation),
    example: { measurement: { need: 10, separation: 9.92 }, magnitude: 0.08 },
  },
};

/**
 * One finding, with its severity resolved through the table.
 *
 * Throws on an undeclared class rather than recording a finding with no magnitude, because a
 * finding whose severity nothing measures is the exact state this table exists to make impossible.
 */
export const finding = (className, key, measurement, detail = {}) => {
  const declared = FINDING_CLASSES[className];
  if (!declared) {
    throw new Error(
      `finding class "${className}" is not declared in FINDING_CLASSES. Add it, with how its ` +
        `severity is measured, before emitting findings under it.`,
    );
  }

  const magnitude = declared.magnitudeOf(measurement);
  if (!Number.isFinite(magnitude)) {
    throw new Error(
      `finding class "${className}" produced a non-numeric magnitude from ` +
        `${JSON.stringify(measurement)} — its measurement shape and its magnitudeOf disagree.`,
    );
  }

  return { key, class: className, magnitude, ...detail };
};
