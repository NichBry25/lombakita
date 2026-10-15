// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { addNote, editNote, listNotes, NOTE_EDITED_EVENT } from "./notes-service";
import type { Database } from "@/server/db/client";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE } from "@/server/institution-verification/operator-institution-conflict";

// The insert runs inside the transaction the deactivation guard opens, so the handle carries a
// select as well: it is what the guard reads the target's status through, and the guard takes that
// row with `.for("update")`. An empty result is a target the guard finds nothing to refuse.
const makeInsertDb = () => {
  const values: Array<Record<string, unknown>> = [];
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          // Both shapes: the chain is awaited on its own somewhere and the guard appends `.for`.
          limit: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([]),
            then: (onFulfilled: (rows: unknown[]) => unknown) =>
              Promise.resolve([]).then(onFulfilled),
          }),
        }),
      }),
    }),
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
  };
  const db = {
    transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
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
  // The transaction serves its reads in call order: the acting account, the note, then (for a note
  // about an institution) the four reads of the institution-relationship check — membership, filed
  // submission, the actor's email, invitation. The order is part of what is asserted: a writer that
  // reads the note before the actor reads the actor's row as the note.
  const OPS_ACTOR_ROW = { id: "ops1", role: "platform_ops", suspendedAt: null };

  const makeEditDb = (
    noteExists: boolean,
    newText = "updated text",
    extras: {
      actorRow?: Record<string, unknown> | null;
      note?: Record<string, unknown>;
      relationshipReads?: Array<Array<Record<string, unknown>>>;
      updatedRows?: Array<Record<string, unknown>>;
    } = {},
  ) => {
    const existingNote = {
      id: "n1",
      note: "original text",
      createdById: "ops1",
      targetUserId: "user_1",
      targetInstitutionId: null,
      ...extras.note,
    };
    const actorRow = extras.actorRow === undefined ? OPS_ACTOR_ROW : extras.actorRow;
    const reads = [
      actorRow ? [actorRow] : [],
      noteExists ? [existingNote] : [],
      ...(extras.relationshipReads ?? []),
    ];
    let selectCall = 0;
    const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn(() => Promise.resolve(reads[selectCall++] ?? [])),
          }),
        }),
      })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue(
                extras.updatedRows ?? [
                  { id: "n1", note: newText, createdById: "ops1", createdAt: new Date() },
                ],
              ),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue(insertChain),
    };
    const db = {
      select: vi.fn(),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as Database;
    return { db, tx, insertChain, existingNote };
  };

  it("returns updated note on success", async () => {
    const { db } = makeEditDb(true, "corrected note");
    const res = await editNote("ops1", "n1", "corrected note", db);
    expect(res.note).toBe("corrected note");
    expect(res.id).toBe("n1");
  });

  // An edit overwrites in place and any ops actor may edit any note, so the replaced text is only
  // recoverable if the audit row captures it.
  it("captures the replaced text and the original author in the audit row", async () => {
    const { db, insertChain } = makeEditDb(true, "corrected note", {
      actorRow: { id: "ops2", role: "platform_ops", suspendedAt: null },
    });

    await editNote("ops2", "n1", "corrected note", db);

    expect(insertChain.values).toHaveBeenCalledWith({
      actorUserId: "ops2",
      targetUserId: "user_1",
      targetInstitutionId: null,
      eventType: NOTE_EDITED_EVENT,
      metadata: {
        noteId: "n1",
        previousNote: "original text",
        noteAuthorId: "ops1",
      },
    });
    // Overwrite and audit row land together or not at all.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("writes no audit row when the note does not exist", async () => {
    const { db, insertChain } = makeEditDb(false);

    await expect(editNote("ops1", "missing", "new text", db)).rejects.toMatchObject({
      code: "note_not_found",
    });
    expect(insertChain.values).not.toHaveBeenCalled();
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

  it("validates blank text before any database work", async () => {
    const { db, tx } = makeEditDb(true);
    await expect(editNote("ops1", "n1", "   ", db)).rejects.toMatchObject({
      code: "note_required",
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", actorRow: null, code: "operator_actor_not_found" },
    {
      label: "candidate",
      actorRow: { id: "ops1", role: "candidate", suspendedAt: null },
      code: "operator_actor_not_platform_ops",
    },
    {
      label: "suspended operator",
      actorRow: { id: "ops1", role: "platform_ops", suspendedAt: new Date() },
      code: "operator_actor_suspended",
    },
  ])("refuses a $label actor before reading the note, and writes nothing", async (testCase) => {
    const { db, tx, insertChain } = makeEditDb(false, "new text", { actorRow: testCase.actorRow });
    const refusal = await editNote("ops1", "n1", "new text", db).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({ code: testCase.code, status: 403 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(insertChain.values).not.toHaveBeenCalled();
  });

  it("refuses an actor editing a note written about them, and writes nothing", async () => {
    const { db, tx, insertChain } = makeEditDb(true, "new text", {
      note: { createdById: "someone-else", targetUserId: "ops1" },
    });
    const refusal = await editNote("ops1", "n1", "new text", db).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_is_target",
      status: 403,
      message: "A platform-ops account cannot edit a note written about it",
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(insertChain.values).not.toHaveBeenCalled();
  });

  it("refuses a note about an institution the actor holds a membership in", async () => {
    const { db, tx, insertChain } = makeEditDb(true, "new text", {
      note: { targetUserId: null, targetInstitutionId: "inst_1" },
      relationshipReads: [[{ id: "membership_1" }]],
    });
    const refusal = await editNote("ops1", "n1", "new text", db).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_conflicted",
      status: 403,
      message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(insertChain.values).not.toHaveBeenCalled();
  });

  it("edits a note about an institution the actor has no relationship to", async () => {
    const { db, insertChain } = makeEditDb(true, "new text", {
      note: { targetUserId: null, targetInstitutionId: "inst_1" },
      relationshipReads: [[], [], [{ email: "ops@example.test" }], []],
    });
    await editNote("ops1", "n1", "new text", db);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
  });

  it("writes exactly one audit row naming the database actor", async () => {
    const { db, insertChain } = makeEditDb(true, "corrected note", {
      actorRow: { id: "database-actor", role: "platform_ops", suspendedAt: null },
    });
    await editNote("claimed-actor", "n1", "corrected note", db);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.values.mock.calls[0]![0]).toMatchObject({
      actorUserId: "database-actor",
      eventType: NOTE_EDITED_EVENT,
    });
  });

  it("writes no audit row when the update changed no row", async () => {
    const { db, insertChain } = makeEditDb(true, "new text", { updatedRows: [] });
    await expect(editNote("ops1", "n1", "new text", db)).rejects.toThrow(
      "Failed to update platform ops note",
    );
    expect(insertChain.values).not.toHaveBeenCalled();
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
