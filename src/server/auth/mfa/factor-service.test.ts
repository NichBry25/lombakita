// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { createEnrolmentTestDatabase } from "./enrolment-test-db";

vi.mock("./mfa-encryption", () => ({
  encryptMfaSecret: vi.fn(() => ({ ciphertext: "ciphertext", iv: "iv", authTag: "tag" })),
  decryptMfaSecret: vi.fn(),
}));

import { startMfaEnrolment } from "./factor-service";

const activeOperator = {
  email: "operator@example.test",
  username: "operator",
  role: "platform_ops",
  status: "active",
  suspendedAt: null as Date | null,
};

describe("startMfaEnrolment account refusal", () => {
  it.each([
    { name: "suspended", changes: { suspendedAt: new Date(0) }, code: "account_suspended" },
    { name: "deactivated", changes: { status: "deactivated" }, code: "forbidden" },
    { name: "non-operational", changes: { role: "candidate" }, code: "forbidden" },
    { name: "undefined role", changes: { role: undefined }, code: "forbidden" },
    { name: "unknown role", changes: { role: "unknown_role" }, code: "forbidden" },
  ])("refuses $name without a factor write", async ({ changes, code }) => {
    const db = createEnrolmentTestDatabase({ ...activeOperator, ...changes });
    const refusal = startMfaEnrolment("operator", db.database);
    await expect(refusal).rejects.toBeInstanceOf(AccessError);
    await expect(refusal).rejects.toMatchObject({ code, status: 403 });
    expect(db.factorRows).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it.each(["platform_ops", "finance_ops", "reviewer_or_judge"])(
    "enrols a valid %s",
    async (role) => {
      const db = createEnrolmentTestDatabase({ ...activeOperator, role });
      const result = await startMfaEnrolment("operator", db.database);
      expect(result.secretBase32).toMatch(/^[A-Z2-7]+$/);
      expect(result.otpauthUri).toContain("otpauth://totp/");
      expect(db.factorRows).toHaveLength(1);
      expect(db.insert).toHaveBeenCalledOnce();
    },
  );
});
