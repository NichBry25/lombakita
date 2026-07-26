// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { addNote, editNote, listNotes } from "./notes-service";
import type { Database } from "@/server/db/client";

const makeInsertDb = () => {
  const values: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn((v: Record<string, unknown>) => {
        values.push(v);
        return {
          returning: vi
            .fn()
            .mockResolvedValue([
              { id: "n1", note: v.note, createdById: "ops1", createdAt: new Date() },
            ]),
        };
      }),
    }),
  } as unknown as Database;
  return { db, values };
};

const makeListDb = (rows: Array<Record<string, unknown>>) =>
  ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  }) as unknown as Database;

beforeEach(() => vi.clearAllMocks());

describe("addNote target invariant", () => {
  it("rejects when neither target is provided", async () => {
    const { db } = makeInsertDb();
    await expect(addNote("ops1", { note: "hi" }, db)).rejects.toMatchObject({
      code: "invalid_note_target",
      status: 400,
    });
  });

  it("rejects when both targets are provided", async () => {
    const { db } = makeInsertDb();
    await expect(
      addNote("ops1", { targetUserId: "u1", targetInstitutionId: "i1", note: "hi" }, db),
    ).rejects.toMatchObject({ code: "invalid_note_target", status: 400 });
  });

  it("rejects an empty note with note_required", async () => {
    const { db } = makeInsertDb();
    await expect(addNote("ops1", { targetUserId: "u1", note: "   " }, db)).rejects.toMatchObject({
      code: "note_required",
      status: 400,
    });
  });

  it("inserts a user-targeted note with createdById = actor", async () => {
    const { db, values } = makeInsertDb();
    const res = await addNote("ops1", { targetUserId: "u1", note: "flagged" }, db);
    expect(res.id).toBe("n1");
    expect(values[0]).toMatchObject({
      targetUserId: "u1",
      targetInstitutionId: null,
      note: "flagged",
      createdById: "ops1",
    });
  });
});

// F21 — in-place note editing (Step 6.5b)
describe("editNote", () => {
  const makeEditDb = (noteExists: boolean, newText = "updated text") => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(noteExists ? [{ id: "n1", createdById: "ops1" }] : []),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([
                { id: "n1", note: newText, createdById: "ops1", createdAt: new Date() },
              ]),
          }),
        }),
      }),
    } as unknown as Database;
    return { db };
  };

  it("returns updated note on success", async () => {
    const { db } = makeEditDb(true, "corrected note");
    const res = await editNote("ops1", "n1", "corrected note", db);
    expect(res.note).toBe("corrected note");
    expect(res.id).toBe("n1");
  });

  it("throws note_not_found when the note does not exist", async () => {
    const { db } = makeEditDb(false);
    await expect(editNote("ops1", "missing", "new text", db)).rejects.toMatchObject({
      code: "note_not_found",
      status: 404,
    });
  });

  it("throws note_required when text is blank", async () => {
    const { db } = makeEditDb(true);
    await expect(editNote("ops1", "n1", "   ", db)).rejects.toMatchObject({
      code: "note_required",
      status: 400,
    });
  });
});

describe("listNotes", () => {
  it("rejects when neither target is provided", async () => {
    const db = makeListDb([]);
    await expect(listNotes({}, db)).rejects.toMatchObject({ code: "invalid_note_target" });
  });

  it("returns notes for a valid institution target", async () => {
    const db = makeListDb([
      { id: "n1", note: "x", createdById: "ops1", createdByName: "Ops", createdAt: new Date() },
    ]);
    const res = await listNotes({ targetInstitutionId: "i1" }, db);
    expect(res).toHaveLength(1);
    expect(res[0]?.createdByName).toBe("Ops");
  });
});
