// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  hashPassword,
  hashVerificationToken,
  issueVerificationToken,
  verifyPassword,
} from "@/server/auth/password";

describe("password utilities", () => {
  it("hashes and verifies password", async () => {
    const hash = await hashPassword("strong-pass-123");

    expect(hash.startsWith("s1$")).toBe(true);
    await expect(verifyPassword("strong-pass-123", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-pass", hash)).resolves.toBe(false);
  });

  it("issues verification token and generates deterministic hash", () => {
    const issued = issueVerificationToken();

    expect(issued.rawToken).toMatch(/^[a-f0-9]{64}$/i);
    expect(issued.tokenHash).toBe(hashVerificationToken(issued.rawToken));
  });
});
