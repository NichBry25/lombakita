// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { SavedCompetitionError } from "@/server/saved-competitions/saved-competition-service";

const { requireSessionRole, saveCompetition, unsaveCompetition } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  saveCompetition: vi.fn(),
  unsaveCompetition: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/saved-competitions/saved-competition-service", () => {
  class SavedCompetitionError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    saveCompetition,
    unsaveCompetition,
    SavedCompetitionError,
    toSavedCompetitionErrorResponse: (err: SavedCompetitionError) =>
      Response.json({ error: { code: err.code } }, { status: err.status }),
  };
});

import { DELETE, POST } from "./route";

const candidateSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = (competitionId = "comp_1") => ({
  params: Promise.resolve({ competitionId }),
});

const makeRequest = (method: "POST" | "DELETE") =>
  new Request(`http://localhost/api/v1/competitions/comp_1/save`, { method });

describe("POST /api/v1/competitions/[competitionId]/save", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 { saved: true } for an authenticated candidate", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    saveCompetition.mockResolvedValue(undefined);

    const res = await POST(makeRequest("POST") as never, makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ saved: true });
    expect(saveCompetition).toHaveBeenCalledWith("stud_1", "comp_1");
  });

  it("returns 200 { saved: true } on duplicate save (idempotent)", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    saveCompetition.mockResolvedValue(undefined); // onConflictDoNothing swallows dup

    const res = await POST(makeRequest("POST") as never, makeContext());
    expect(res.status).toBe(200);
    expect((await res.json()).saved).toBe(true);
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await POST(makeRequest("POST") as never, makeContext());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is platform_ops (not a candidate)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await POST(makeRequest("POST") as never, makeContext());
    expect(res.status).toBe(403);
  });

  it("returns 404 when competition does not exist", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    saveCompetition.mockRejectedValue(
      new SavedCompetitionError("competition_not_found", 404, "Competition not found"),
    );

    const res = await POST(makeRequest("POST") as never, makeContext());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("competition_not_found");
  });
});

describe("DELETE /api/v1/competitions/[competitionId]/save", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 { saved: false } for an authenticated candidate", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    unsaveCompetition.mockResolvedValue(undefined);

    const res = await DELETE(makeRequest("DELETE") as never, makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ saved: false });
    expect(unsaveCompetition).toHaveBeenCalledWith("stud_1", "comp_1");
  });

  it("returns 200 { saved: false } when competition was not saved (idempotent)", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    unsaveCompetition.mockResolvedValue(undefined); // plain delete always resolves

    const res = await DELETE(makeRequest("DELETE") as never, makeContext());
    expect(res.status).toBe(200);
    expect((await res.json()).saved).toBe(false);
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await DELETE(makeRequest("DELETE") as never, makeContext());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is recruiter (not a candidate)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await DELETE(makeRequest("DELETE") as never, makeContext());
    expect(res.status).toBe(403);
  });
});
