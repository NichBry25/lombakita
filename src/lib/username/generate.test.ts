// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  generateUsername,
  normalizeUsernameBase,
  UsernameGenerationError,
} from "@/lib/username/generate";

// A username produced by generateUsername must itself satisfy the locked
// username validation rule: lowercase alphanumerics + underscores, starts and
// ends alphanumeric, no consecutive underscores.
const VALID_USERNAME = /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/;
const expectValidUsername = (value: string) => {
  expect(value).toMatch(VALID_USERNAME);
  expect(value).not.toMatch(/__/);
  expect(value.length).toBeGreaterThanOrEqual(3);
  expect(value.length).toBeLessThanOrEqual(30);
};

// Produces a suffix generator that yields the given sequence in order.
const suffixSeq = (values: string[]): (() => string) => {
  let i = 0;
  return () => values[i++] ?? "0000";
};

describe("normalizeUsernameBase", () => {
  it("joins first and last name with an underscore, lowercased", () => {
    expect(normalizeUsernameBase("John", "Doe")).toBe("john_doe");
  });

  it("replaces spaces and special characters with underscores and collapses them", () => {
    expect(normalizeUsernameBase("Mary-Jane", "Watson!!!")).toBe("mary_jane_watson");
    expect(normalizeUsernameBase("  John  ", "  Doe  ")).toBe("john_doe");
  });

  it("ASCII-normalizes non-ASCII Latin characters", () => {
    expect(normalizeUsernameBase("Ärjuna", "Wibowo")).toBe("arjuna_wibowo");
    expect(normalizeUsernameBase("José", "Núñez")).toBe("jose_nunez");
  });

  it("falls back to 'user' when no usable characters remain", () => {
    expect(normalizeUsernameBase("", "")).toBe("user");
    expect(normalizeUsernameBase("@@@", "###")).toBe("user");
    // Non-Latin scripts have no ASCII decomposition and are dropped.
    expect(normalizeUsernameBase("田中", "")).toBe("user");
  });

  it("truncates an over-long base so base + suffix fits within 30 chars", () => {
    const base = normalizeUsernameBase("a".repeat(40), "b".repeat(40));
    expect(base.length).toBeLessThanOrEqual(25);
    expect(base).not.toMatch(/_$/);
  });
});

describe("generateUsername", () => {
  it("produces a valid username on the happy path", async () => {
    const username = await generateUsername({
      firstName: "Budi",
      lastName: "Santoso",
      isAvailable: async () => true,
      suffixGenerator: suffixSeq(["4821"]),
    });

    expect(username).toBe("budi_santoso_4821");
    expectValidUsername(username);
  });

  it("ASCII-normalizes a non-ASCII name into the generated username", async () => {
    const username = await generateUsername({
      firstName: "Ärjuna",
      lastName: "Wibowo",
      isAvailable: async () => true,
      suffixGenerator: suffixSeq(["1234"]),
    });

    expect(username).toBe("arjuna_wibowo_1234");
    expect(username).not.toMatch(/[^a-z0-9_]/);
  });

  it("falls back to the 'user' base when name parts are empty", async () => {
    const username = await generateUsername({
      firstName: "",
      lastName: "",
      isAvailable: async () => true,
      suffixGenerator: suffixSeq(["9090"]),
    });

    expect(username).toBe("user_9090");
    expectValidUsername(username);
  });

  it("loops past taken candidates until a free one is found", async () => {
    const isAvailable = vi
      .fn<(c: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const username = await generateUsername({
      firstName: "John",
      lastName: "Doe",
      isAvailable,
      suffixGenerator: suffixSeq(["1111", "2222", "3333"]),
    });

    expect(username).toBe("john_doe_3333");
    expect(isAvailable).toHaveBeenCalledTimes(3);
  });

  it("skips a candidate that matches a reserved word", async () => {
    const isAvailable = vi.fn<(c: string) => Promise<boolean>>().mockResolvedValue(true);

    // Empty suffix on the first attempt makes the candidate the bare base
    // 'admin' — a reserved word — which must be skipped without an availability
    // probe; the second attempt produces a suffixed, non-reserved candidate.
    const username = await generateUsername({
      firstName: "Admin",
      lastName: "",
      isAvailable,
      suffixGenerator: suffixSeq(["", "7777"]),
    });

    expect(username).toBe("admin_7777");
    expect(isAvailable).toHaveBeenCalledTimes(1);
    expect(isAvailable).toHaveBeenCalledWith("admin_7777");
  });

  it("throws UsernameGenerationError when the bounded retry loop is exhausted", async () => {
    const isAvailable = vi.fn<(c: string) => Promise<boolean>>().mockResolvedValue(false);

    await expect(
      generateUsername({
        firstName: "Always",
        lastName: "Taken",
        isAvailable,
        maxAttempts: 5,
        suffixGenerator: suffixSeq(["1", "2", "3", "4", "5", "6"]),
      }),
    ).rejects.toBeInstanceOf(UsernameGenerationError);

    expect(isAvailable).toHaveBeenCalledTimes(5);
  });

  it("gives identical names distinct usernames via the numeric suffix", async () => {
    const first = await generateUsername({
      firstName: "Sri",
      lastName: "Lestari",
      isAvailable: async () => true,
      suffixGenerator: suffixSeq(["1001"]),
    });
    const second = await generateUsername({
      firstName: "Sri",
      lastName: "Lestari",
      isAvailable: async () => true,
      suffixGenerator: suffixSeq(["2002"]),
    });

    expect(first).not.toBe(second);
    expect(first).toBe("sri_lestari_1001");
    expect(second).toBe("sri_lestari_2002");
  });
});
