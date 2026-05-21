// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RESERVED_WORDS } from "@/lib/username/reserved-words";

// CCR-20 / B8 mandated minimum — the reserved list must always cover every one
// of these system route segments.
const CCR20_MINIMUM = [
  "auth",
  "profile",
  "settings",
  "candidate-dashboard",
  "recruiter-dashboard",
  "institution",
  "notifications",
  "certificates",
  "competitions",
  "compete",
  "hackathons",
  "scholarships",
  "workshops",
  "conferences",
  "faq",
  "about",
  "terms",
  "privacy",
  "refund-policy",
  "admin",
  "api",
  "static",
];

describe("RESERVED_WORDS", () => {
  it("covers every CCR-20 / B8 mandated word", () => {
    for (const word of CCR20_MINIMUM) {
      expect(RESERVED_WORDS).toContain(word);
    }
  });

  it("is entirely lowercase", () => {
    for (const word of RESERVED_WORDS) {
      expect(word).toBe(word.toLowerCase());
    }
  });

  it("contains no duplicate entries", () => {
    expect(new Set(RESERVED_WORDS).size).toBe(RESERVED_WORDS.length);
  });
});
