import { describe, expect, it } from "vitest";
import { sameSitePathOr, sameSiteReturnPathOr } from "./return-path";

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
  { input: "/admin\u007f", expected: FALLBACK },
  { input: "/search?q=a b", expected: "/search?q=a b" },
];

describe("sameSitePathOr", () => {
  for (const { input, expected } of ROWS) {
    it(`returns ${JSON.stringify(expected)} for ${JSON.stringify(input)}`, () => {
      expect(sameSitePathOr(input, FALLBACK)).toBe(expected);
    });
  }

  it("keeps a path of exactly 512 characters", () => {
    const path = "/" + "a".repeat(511);

    expect(sameSitePathOr(path, FALLBACK)).toBe(path);
  });

  it("drops a path longer than 512 characters", () => {
    expect(sameSitePathOr("/" + "a".repeat(512), FALLBACK)).toBe(FALLBACK);
  });
});

describe("sameSiteReturnPathOr", () => {
  const SITE = "https://lombakita.local";

  it("keeps a path on this site", () => {
    expect(sameSiteReturnPathOr("/competitions/acme/lomba-1", SITE, FALLBACK)).toBe(
      "/competitions/acme/lomba-1",
    );
  });

  it("keeps the path, query and fragment of an absolute address on this site", () => {
    const address = "https://lombakita.local/competitions/acme/lomba-1?tab=hadiah#jadwal";

    expect(sameSiteReturnPathOr(address, SITE, FALLBACK)).toBe(
      "/competitions/acme/lomba-1?tab=hadiah#jadwal",
    );
  });

  it("drops an absolute address on another site", () => {
    const addresses = [
      "https://example.com/competitions/acme/lomba-1",
      "https://lombakita.local.example.com/x",
      "http://lombakita.local/x",
      "https://lombakita.local:8443/x",
    ];

    for (const address of addresses) {
      expect(sameSiteReturnPathOr(address, SITE, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("drops an absolute address on this site whose path leads to another site", () => {
    expect(sameSiteReturnPathOr("https://lombakita.local//example.com", SITE, FALLBACK)).toBe(
      FALLBACK,
    );
    expect(sameSiteReturnPathOr("https://lombakita.local/\\example.com", SITE, FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("drops an absolute address whose path is longer than 512 characters", () => {
    const address = "https://lombakita.local/" + "a".repeat(512);

    expect(sameSiteReturnPathOr(address, SITE, FALLBACK)).toBe(FALLBACK);
  });

  it("keeps only paths when the site origin is unknown", () => {
    expect(sameSiteReturnPathOr("https://lombakita.local/x", undefined, FALLBACK)).toBe(FALLBACK);
    expect(sameSiteReturnPathOr("/x", undefined, FALLBACK)).toBe("/x");
  });

  it("drops what the path check drops", () => {
    expect(sameSiteReturnPathOr("//example.com", SITE, FALLBACK)).toBe(FALLBACK);
    expect(sameSiteReturnPathOr("javascript:alert(1)", SITE, FALLBACK)).toBe(FALLBACK);
  });
});
