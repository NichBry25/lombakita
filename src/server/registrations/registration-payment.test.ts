// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { CompetitionError } from "@/server/competitions/competition-core";
import { PaymentDatabaseError, PaymentError } from "@/server/finance/payment-service";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";
import { createRegistrationPayment } from "@/server/registrations/registration-payment";
import { RegistrationPaymentError } from "@/server/registrations/registration-payment-core";

const { createPaymentMock } = vi.hoisted(() => ({ createPaymentMock: vi.fn() }));

vi.mock("@/server/finance/payment-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/finance/payment-service")>()),
  createPayment: createPaymentMock,
}));

const pricing: Parameters<typeof createRegistrationPayment>[0] = {
  id: "comp_1",
  institutionId: "inst_1",
  feeAmount: 150_000,
  feeCurrency: "IDR",
  paymentWindowDays: 3,
  registrationEndAt: new Date("2026-12-31T00:00:00Z"),
};

const call = () =>
  createRegistrationPayment(
    pricing,
    "reg_1",
    "user_1",
    new Date("2026-11-11T00:00:00Z"),
    {} as never,
  );

describe("createRegistrationPayment refusals", () => {
  it("names an organiser that is not verified as unable to take payment", async () => {
    createPaymentMock.mockRejectedValueOnce(
      new CompetitionError("competition_institution_not_verified", 422, "x"),
    );
    await expect(call()).rejects.toBeInstanceOf(RegistrationPaymentError);
  });

  it("names an organiser with no published account as unable to take payment", async () => {
    createPaymentMock.mockRejectedValueOnce(
      new PaymentInstructionsError("payment_instructions_missing", "x", 409),
    );
    await expect(call()).rejects.toBeInstanceOf(RegistrationPaymentError);
  });

  it("names an organiser with no fee rule as unable to take payment", async () => {
    createPaymentMock.mockRejectedValueOnce(new PaymentError("payment_fee_rule_not_found", "x"));
    await expect(call()).rejects.toBeInstanceOf(RegistrationPaymentError);
  });

  it("lets a database fault through as itself", async () => {
    const fault = new PaymentDatabaseError("insert finance_payments", "08006", null);
    createPaymentMock.mockRejectedValueOnce(fault);
    await expect(call()).rejects.toBe(fault);
  });

  it("lets a currency fault through as itself", async () => {
    const fault = new PaymentError("payment_fee_rule_currency_mismatch", "x");
    createPaymentMock.mockRejectedValueOnce(fault);
    await expect(call()).rejects.toBe(fault);
  });
});
