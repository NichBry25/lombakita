// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { InstitutionInvitationError } from "@/server/institution-invitations/invitation-core";

const { declineInvitation } = vi.hoisted(() => ({
  declineInvitation: vi.fn(),
}));

vi.mock("@/server/institution-invitations/invitation-service", () => ({ declineInvitation }));

import { POST } from "@/app/api/v1/auth/invitations/decline/route";

const RAW_TOKEN = "b".repeat(64);

describe("POST /api/v1/auth/invitations/decline", () => {
  afterEach(() => vi.clearAllMocks());

  it("declines a valid pending invitation without authentication", async () => {
    declineInvitation.mockResolvedValue(undefined);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.declined).toBe(true);
    expect(declineInvitation).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it("returns 410 for already-accepted invitation", async () => {
    declineInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        "Invitation is accepted and cannot be declined",
      ),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(410);
  });

  it("returns 410 for cancelled invitation", async () => {
    declineInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        "Invitation is cancelled and cannot be declined",
      ),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(410);
  });

  it("returns 404 for unknown token", async () => {
    declineInvitation.mockRejectedValue(
      new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found"),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(404);
  });

  it("returns 400 for missing token in body", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invitation_invalid_payload");
  });
});
