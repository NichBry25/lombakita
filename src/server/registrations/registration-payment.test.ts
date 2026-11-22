// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompetitionError } from "@/server/competitions/competition-core";
import { PaymentDatabaseError, PaymentError } from "@/server/finance/payment-service";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";
import { createRegistrationPayment } from "@/server/registrations/registration-payment";
import { RegistrationPaymentError } from "@/server/registrations/registration-payment-core";

const { createPaymentMock, loggerWarnMock } = vi.hoisted(() => ({
  createPaymentMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("@/server/finance/payment-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/finance/payment-service")>()),
  createPayment: createPaymentMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarnMock, error: vi.fn(), info: vi.fn() },
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names an organiser that is not verified as unable to take payment", async () => {
    const refusal = new CompetitionError("competition_institution_not_verified", 422, "x");
    createPaymentMock.mockRejectedValueOnce(refusal);
    await expect(call()).rejects.toMatchObject({
      code: "registration_payment_unavailable",
      cause: refusal,
    });
    expect(loggerWarnMock).toHaveBeenCalledWith("registration.payment_unavailable", {
      institutionId: "inst_1",
      reason: refusal.code,
    });
  });

  it("names an organiser with no published account as unable to take payment", async () => {
    const refusal = new PaymentInstructionsError("payment_instructions_missing", "x", 409);
    createPaymentMock.mockRejectedValueOnce(refusal);
    await expect(call()).rejects.toMatchObject({
      code: "registration_payment_unavailable",
      cause: refusal,
    });
    expect(loggerWarnMock).toHaveBeenCalledWith("registration.payment_unavailable", {
      institutionId: "inst_1",
      reason: refusal.code,
    });
  });

  it("names an organiser with no fee rule as unable to take payment", async () => {
    const refusal = new PaymentError("payment_fee_rule_not_found", "x");
    createPaymentMock.mockRejectedValueOnce(refusal);
    await expect(call()).rejects.toMatchObject({
      code: "registration_payment_unavailable",
      cause: refusal,
    });
    expect(loggerWarnMock).toHaveBeenCalledWith("registration.payment_unavailable", {
      institutionId: "inst_1",
      reason: refusal.code,
    });
  });

  it("lets a database fault through as itself", async () => {
    const fault = new PaymentDatabaseError("insert finance_payments", "08006", null);
    createPaymentMock.mockRejectedValueOnce(fault);
    await expect(call()).rejects.toBe(fault);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("lets a currency fault through as itself", async () => {
    const fault = new PaymentError("payment_fee_rule_currency_mismatch", "x");
    createPaymentMock.mockRejectedValueOnce(fault);
    await expect(call()).rejects.toBe(fault);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("treats a priced competition with no currency as a fault, not a refusal", async () => {
    const rejection = await createRegistrationPayment(
      { ...pricing, feeCurrency: null },
      "reg_1",
      "user_1",
      new Date("2026-11-11T00:00:00Z"),
      {} as never,
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(RegistrationPaymentError);
    expect((rejection as Error).message).toBe(
      "A priced competition has no currency, which its CHECK forbids",
    );
    expect(createPaymentMock).not.toHaveBeenCalled();
  });
});
