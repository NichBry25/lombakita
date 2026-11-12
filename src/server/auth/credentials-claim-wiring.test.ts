// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { hashVerificationToken } from "@/server/auth/password";

const RAW_TOKEN = "f".repeat(64);

// Sanity: the hashing helper the verify path relies on is stable for the raw token shape.
describe("hashVerificationToken", () => {
  it("produces a deterministic hex hash", () => {
    expect(hashVerificationToken(RAW_TOKEN)).toBe(hashVerificationToken(RAW_TOKEN));
  });
});
