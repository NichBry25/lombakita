import { describe, expect, it } from "vitest";
import { sameSitePathOr } from "./return-path";

const FALLBACK = "/home";

const ROWS: ReadonlyArray<{ input: string | null | undefined; expected: string }> = [
  { input: "/admin", expected: "/admin" },
  { input: "/competitions/acme/lomba?tab=1", expected: "/competitions/acme/lomba?tab=1" },
  { input: "/%2F%2Fexample.com", expected: "/%2F%2Fexample.com" },
  { input: "", expected: FALLBACK },
  { input: undefined, expected: FALLBACK },
  { input: null, expected: FALLBACK },
  { input: "admin", expected: FALLBACK },
  { input: "https://example.com", expected: FALLBACK },
  { input: "//example.com", expected: FALLBACK },
  { input: "/\\example.com", expected: FALLBACK },
  { input: "/\t/example.com", expected: FALLBACK },
  { input: "/admin\n", expected: FALLBACK },
  { input: "javascript:alert(1)", expected: FALLBACK },
];

describe("sameSitePathOr", () => {
  for (const { input, expected } of ROWS) {
    it(`returns ${JSON.stringify(expected)} for ${JSON.stringify(input)}`, () => {
      expect(sameSitePathOr(input, FALLBACK)).toBe(expected);
    });
  }
});
