// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, addNote, listNotes, ModerationError } = vi.hoisted(() => {
  class ModerationError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { requireSessionRole: vi.fn(), addNote: vi.fn(), listNotes: vi.fn(), ModerationError };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/moderation/notes-service", () => ({ addNote, listNotes }));
vi.mock("@/server/moderation/moderation-core", () => ({
  ModerationError,
  toModerationErrorResponse: (e: { code: string; message: string; status: number }) =>
    new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), {
      status: e.status,
      headers: { "content-type": "application/json" },
    }),
}));

import { GET, POST } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const postReq = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/notes", {
    method: "POST",
    body: JSON.stringify(body),
  });
const getReq = (qs: string) => new Request(`http://localhost/api/platform-ops/notes${qs}`);

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  addNote.mockResolvedValue({ id: "n1", note: "x", createdById: "ops1", createdByName: null, createdAt: new Date() });
  listNotes.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/platform-ops/notes", () => {
  it("returns 200 and forwards target + note to the service", async () => {
    const res = await POST(postReq({ targetUserId: "u1", note: "flagged" }));
    expect(res.status).toBe(200);
    expect(addNote).toHaveBeenCalledWith("ops1", {
      targetUserId: "u1",
      targetInstitutionId: null,
      note: "flagged",
    });
  });

  it("returns 400 invalid_note_target from the service", async () => {
    addNote.mockRejectedValueOnce(new ModerationError("invalid_note_target", 400, "no"));
    const res = await POST(postReq({ note: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await POST(postReq({ targetUserId: "u1", note: "x" }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/platform-ops/notes", () => {
  it("returns 200 with notes", async () => {
    const res = await GET(getReq("?targetUserId=u1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toEqual([]);
  });

  it("returns 400 invalid_note_target when both targets provided", async () => {
    listNotes.mockRejectedValueOnce(new ModerationError("invalid_note_target", 400, "no"));
    const res = await GET(getReq("?targetUserId=u1&targetInstitutionId=i1"));
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await GET(getReq("?targetUserId=u1"));
    expect(res.status).toBe(403);
  });
});
