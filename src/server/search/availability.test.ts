// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const mockServerEnv = vi.hoisted(() => ({
  meilisearchHost: undefined as string | undefined,
}));

vi.mock("@/config/env.server", () => ({ serverEnv: mockServerEnv }));

import { isMeilisearchAvailable } from "@/server/search/availability";

describe("isMeilisearchAvailable", () => {
  it("returns true when meilisearchHost is present", () => {
    mockServerEnv.meilisearchHost = "https://search.example.com";
    expect(isMeilisearchAvailable()).toBe(true);
  });

  it("returns false when meilisearchHost is undefined", () => {
    mockServerEnv.meilisearchHost = undefined;
    expect(isMeilisearchAvailable()).toBe(false);
  });

  it("returns false when meilisearchHost is empty string", () => {
    mockServerEnv.meilisearchHost = "";
    expect(isMeilisearchAvailable()).toBe(false);
  });
});
