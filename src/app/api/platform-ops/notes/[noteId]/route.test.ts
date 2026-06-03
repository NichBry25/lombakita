// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, editNote, ModerationError } = vi.hoisted(() => {
  class ModerationError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { requireSessionRole: vi.fn(), editNote: vi.fn(), ModerationError };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/moderation/notes-service", () => ({ editNote }));
vi.mock("@/server/moderation/moderation-core", () => ({
  ModerationError,
  toModerationErrorResponse: (e: { code: string; message: string; status: number }) =>
    new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), {
      status: e.status,
      headers: { "content-type": "application/json" },
    }),
}));

import { PATCH } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/notes/n1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ noteId: "n1" }) };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  editNote.mockResolvedValue({ id: "n1", note: "updated", createdById: "ops1", createdByName: null, createdAt: new Date() });
});
afterEach(() => vi.clearAllMocks());

describe("PATCH /api/platform-ops/notes/[noteId] — F21 (Step 6.5b)", () => {
  it("returns 200 and forwards (actor, noteId, text) to the service for platform_ops", async () => {
    const res = await PATCH(patchReq({ note: "updated" }), ctx);
    expect(res.status).toBe(200);
    expect(editNote).toHaveBeenCalledWith("ops1", "n1", "updated");
  });

  it("returns 403 and does NOT edit when the caller is not platform_ops (F21-3)", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await PATCH(patchReq({ note: "tampered" }), ctx);
    expect(res.status).toBe(403);
    expect(editNote).not.toHaveBeenCalled();
  });

  it("returns 401 and does NOT edit when the caller is unauthenticated", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("unauthenticated", 401, "no"));
    const res = await PATCH(patchReq({ note: "tampered" }), ctx);
    expect(res.status).toBe(401);
    expect(editNote).not.toHaveBeenCalled();
  });

  it("returns 404 note_not_found from the service", async () => {
    editNote.mockRejectedValueOnce(new ModerationError("note_not_found", 404, "not found"));
    const res = await PATCH(patchReq({ note: "x" }), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("note_not_found");
  });
});
