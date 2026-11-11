// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PAGES } from "./pages.mjs";
import { STATE_PAGES } from "./state-pages.mjs";

describe("the gallery's state entries", () => {
  it("builds a list of entries with unique ids across the pages and their states", () => {
    expect(STATE_PAGES.length).toBeGreaterThan(0);
    const ids = [...PAGES.map((page) => page.id), ...STATE_PAGES.map((entry) => entry.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names each entry's state exactly once in its folder name", () => {
    for (const entry of STATE_PAGES) {
      if (entry.state === undefined) continue;
      const stem = entry.id.split("--")[0] ?? "";
      expect(stem.split(entry.state).length - 1, entry.id).toBe(1);
    }
  });

  it("keeps a detail page's signed-in states in the folder of its signed-out page", () => {
    const ids = STATE_PAGES.map((entry) => entry.id);
    expect(ids).toContain("06-detail-open--candA");
    expect(ids).not.toContain("06-detail-open-open--candA");
    expect(ids.some((id) => id.startsWith("33a-payment-awaiting-transfer--"))).toBe(true);
    expect(ids.some((id) => id.includes("awaiting-transfer-awaiting-transfer"))).toBe(false);
    expect(ids.some((id) => id.includes("seed-draft-draft"))).toBe(false);
  });
});
