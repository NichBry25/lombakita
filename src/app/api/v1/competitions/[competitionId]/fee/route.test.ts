// @vitest-environment node
//
// The route reads a body and calls one service; every gate lives in that service and is proven
// against a real database. What is proven here is the boundary, which is where this route already
// had a real defect.
//
// `setCompetitionFee` raises THREE error families across its six gates. A handler converting only
// CompetitionError sends the other two to `toAccessDeniedResponse`, which answers anything it does
// not recognise with HTTP 500 "Unexpected access-guard failure". The R12 refusal (an organiser who
// has not yet published bank details, the most likely legitimate refusal on this surface) arrived
// exactly that way until these tests were written.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";
import { FeeRuleError } from "@/server/finance/fee-rule-service";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";

const { requireAuthenticatedSession, assertSessionMatchesExpectedUser, setCompetitionFee, getDb } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    assertSessionMatchesExpectedUser: vi.fn(),
    setCompetitionFee: vi.fn(),
    getDb: vi.fn(() => ({}) as never),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/db/client", () => ({ getDb }));

vi.mock("@/server/auth/access-core", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/access-core")>(
    "@/server/auth/access-core",
  );
  return { ...actual, assertSessionMatchesExpectedUser };
});

vi.mock("@/server/competitions/competition-fee-service", () => ({ setCompetitionFee }));

import { PUT } from "./route";

const ORGANISER = {
  user: { id: "org_1", role: "recruiter", email: "o@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = { params: Promise.resolve({ competitionId: "comp_1" }) };

const feeRequest = (body: Record<string, unknown>): Request =>
  new Request("http://localhost/api/v1/competitions/comp_1/fee", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const PRICED = { feeAmount: 150_000, feeCurrency: "IDR", feeDisclosureAcknowledged: true };

describe("PUT …/competitions/[competitionId]/fee", () => {
  afterEach(() => vi.resetAllMocks());

  it("passes the price and the acknowledgement through to the service", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    setCompetitionFee.mockResolvedValue(undefined);

    const response = await PUT(feeRequest({ ...PRICED, paymentWindowDays: 3 }), context);

    expect(response.status).toBe(200);
    expect(setCompetitionFee).toHaveBeenCalledWith(
      "org_1",
      "comp_1",
      {
        feeAmount: 150_000,
        feeCurrency: "IDR",
        paymentWindowDays: 3,
        feeDisclosureAcknowledged: true,
      },
      {},
    );
  });

  it("treats a TRUTHY non-boolean acknowledgement as absent", async () => {
    // This field is the platform's evidence of consent to a bill. A `1` or a "yes" from a
    // hand-rolled client must not become a recorded acknowledgement, so the check is `=== true`.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    setCompetitionFee.mockResolvedValue(undefined);

    await PUT(feeRequest({ ...PRICED, feeDisclosureAcknowledged: "yes" }), context);

    expect(setCompetitionFee).toHaveBeenCalledWith(
      "org_1",
      "comp_1",
      expect.objectContaining({ feeDisclosureAcknowledged: false }),
      {},
    );
  });

  it("omits paymentWindowDays entirely when the client does not send one", async () => {
    // The service leaves the window unchanged when the key is absent. Sending a coerced 0 or NaN
    // instead would silently rewrite a deadline nobody edited.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    setCompetitionFee.mockResolvedValue(undefined);

    await PUT(feeRequest(PRICED), context);

    const input = setCompetitionFee.mock.calls[0]![2] as Record<string, unknown>;
    expect("paymentWindowDays" in input).toBe(false);
  });

  it("surfaces the R12 precondition as a 422 in Indonesian, NOT a 500", async () => {
    // The defect these tests found. PaymentInstructionsError is not a CompetitionError, so before
    // the route converted it this refusal reached the organiser as
    // HTTP 500 "Unexpected access-guard failure": an English internal error for an ordinary,
    // recoverable, self-service state.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    setCompetitionFee.mockRejectedValue(
      new PaymentInstructionsError(
        "payment_instructions_missing",
        "Institution has published no payment instructions",
      ),
    );

    const response = await PUT(feeRequest(PRICED), context);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("payment_instructions_missing");
    expect(body.error.message).toContain("Lengkapi informasi pembayaran");
    expect(body.error.message).not.toContain("access-guard");
  });

  it("surfaces a missing fee rule as a 422 in Indonesian, NOT a 500", async () => {
    // Same family of defect. The service's own message is English because until this surface it
    // had no organiser-facing caller; it is translated at the boundary rather than in a service
    // shared with platform_ops tooling.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    setCompetitionFee.mockRejectedValue(
      new FeeRuleError("fee_rule_not_in_force", "No platform fee rule is in force"),
    );

    const response = await PUT(feeRequest(PRICED), context);
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(422);
    expect(body.error.message).toContain("Tarif layanan Lombakita belum dikonfigurasi");
    expect(body.error.message).not.toMatch(/[Ff]ee rule/);
  });

  it("surfaces a blocked edit as the service's own competition error", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    setCompetitionFee.mockRejectedValue(
      new CompetitionError(
        "competition_fee_change_blocked_payment_in_flight",
        409,
        "Tidak dapat mengubah biaya saat bukti transfer belum ditinjau",
      ),
    );

    const response = await PUT(feeRequest(PRICED), context);

    expect(response.status).toBe(409);
  });

  it("WRITES NOTHING for an unauthenticated caller", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, "no"));

    expect((await PUT(feeRequest(PRICED), context)).status).toBe(401);
    expect(setCompetitionFee).not.toHaveBeenCalled();
  });

  it("WRITES NOTHING when the browser session flipped under the form", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    assertSessionMatchesExpectedUser.mockImplementation(() => {
      throw new AccessError("session_user_mismatch", 409, "session changed");
    });

    expect((await PUT(feeRequest(PRICED), context)).status).toBe(409);
    expect(setCompetitionFee).not.toHaveBeenCalled();
  });
});
