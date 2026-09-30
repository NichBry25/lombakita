// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, deidentifyAccount, parseDeidentifyInput, DeidentificationError } =
  vi.hoisted(() => {
    class DeidentificationError extends Error {
      constructor(
        public readonly code: string,
        public readonly status: 400 | 403 | 404 | 409 | 500 | 502 | 503,
        message: string,
      ) {
        super(message);
      }
    }
    return {
      requireSessionRole: vi.fn(),
      deidentifyAccount: vi.fn(),
      parseDeidentifyInput: vi.fn(),
      DeidentificationError,
    };
  });

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/accounts/account-deidentification-service", () => ({
  deidentifyAccount,
  parseDeidentifyInput,
  DeidentificationError,
}));

import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { POST } from "./route";

const platformOpsSession = {
  user: { id: "ops_1", role: "platform_ops", email: "ops@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (accountId: string) => ({ params: Promise.resolve({ accountId }) });

const VALID_INPUT = { confirmUsername: "target_user", reason: "permintaan melalui email" };

beforeEach(() => {
  parseDeidentifyInput.mockImplementation((payload: unknown) => {
    const record = payload as { confirmUsername?: unknown; reason?: unknown };
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof record.confirmUsername === "string" &&
      typeof record.reason === "string"
    ) {
      return { confirmUsername: record.confirmUsername, reason: record.reason };
    }
    throw new DeidentificationError(
      "deidentify_invalid_payload",
      400,
      "confirmUsername and reason must both be strings",
    );
  });
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/platform-ops/accounts/[accountId]/deidentify", () => {
  it("returns 200 with the service result and passes the caller's own id as the actor", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);
    deidentifyAccount.mockResolvedValue({ objectsDeleted: 3, personalInstitutionId: null });

    const response = await POST(makeRequest(VALID_INPUT), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ objectsDeleted: 3, personalInstitutionId: null });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
    expect(deidentifyAccount).toHaveBeenCalledWith("ops_1", "u1", VALID_INPUT);
  });

  it("returns 403 and never reaches the service when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("forbidden", 403, "Insufficient role permissions"),
    );

    const response = await POST(makeRequest(VALID_INPUT), makeParams("u1"));

    expect(response.status).toBe(403);
    expect(deidentifyAccount).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await POST(makeRequest(VALID_INPUT), makeParams("u1"));

    expect(response.status).toBe(401);
    expect(deidentifyAccount).not.toHaveBeenCalled();
  });

  it("returns 400 for a body whose fields are not both strings", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const response = await POST(makeRequest({ confirmUsername: "u", reason: 7 }), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("deidentify_invalid_payload");
    expect(deidentifyAccount).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await POST(request, makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("deidentify_invalid_payload");
    expect(deidentifyAccount).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty accountId", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const response = await POST(makeRequest(VALID_INPUT), makeParams(""));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("deidentify_invalid_payload");
    expect(deidentifyAccount).not.toHaveBeenCalled();
  });

  // Every refusal the service raises reaches the client as `{ error: { code, message } }`, with the
  // status it carried. The confirmation mismatch is asserted by name because it is the one an
  // operator meets by typing; the rest are asserted for their status so a status dropped in the
  // catch chain is caught here rather than by an operator reading a 200.
  it.each([
    ["deidentify_confirmation_mismatch", 400],
    ["deidentify_reason_required", 400],
    ["deidentify_account_not_found", 404],
    ["deidentify_target_is_operator", 403],
    ["deidentify_last_owner", 409],
    ["deidentify_personal_institution_has_published_competition", 409],
    ["deidentify_already_done", 409],
    ["deidentify_storage_unavailable", 503],
    ["deidentify_rehearsal_failed", 500],
    ["deidentify_storage_failed", 502],
  ] as const)("answers %s with %i", async (code, status) => {
    requireSessionRole.mockResolvedValue(platformOpsSession);
    deidentifyAccount.mockRejectedValue(new DeidentificationError(code, status, "sentence"));

    const response = await POST(makeRequest(VALID_INPUT), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe("sentence");
  });

  // The branch the cases above cannot reach: `OperatorActorError` comes from the platform-ops
  // module rather than from the service this file mocks. Without this case the actor branch could
  // be deleted and the suite would stay green — the error would fall through to
  // `toAccessDeniedResponse` and answer a different shape for a longer reason. Every code is
  // asserted, because the branch echoes whichever one it was given.
  it("returns the actor refusal's own code and status for each way the actor can fail", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const refusals = [
      { code: "operator_actor_not_found", message: "The acting account was not found" },
      {
        code: "operator_actor_not_platform_ops",
        message: "The acting account does not hold the platform_ops role",
      },
      {
        code: "operator_actor_suspended",
        message: "The acting account is suspended and cannot perform platform-ops actions",
      },
      {
        code: "operator_actor_is_target",
        message: "Anda tidak dapat menghapus akun Anda sendiri.",
      },
    ] as const;

    for (const refusal of refusals) {
      deidentifyAccount.mockRejectedValue(
        new OperatorActorError(refusal.code, 403, refusal.message),
      );

      const response = await POST(makeRequest(VALID_INPUT), makeParams("u1"));
      const body = await response.json();

      expect(response.status, `${refusal.code} did not answer 403`).toBe(403);
      expect(body.error.code, `${refusal.code} was not echoed`).toBe(refusal.code);
      expect(body.error.message).toBe(refusal.message);
    }
  });
});
