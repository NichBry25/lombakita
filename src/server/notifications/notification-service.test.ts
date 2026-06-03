// @vitest-environment node
//
// Step 6.5.1 — writeNotification + markNotificationAsRead unit tests.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));

import {
  deleteNotification,
  markNotificationAsRead,
  writeNotification,
} from "./notification-service";
import { NOTIFICATION_TYPES } from "./notification-types";

// ── writeNotification ─────────────────────────────────────────────────────────

describe("writeNotification", () => {
  afterEach(() => vi.clearAllMocks());

  it("inserts a notification row with the supplied fields", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    await writeNotification(
      db,
      "user_1",
      NOTIFICATION_TYPES.registrationConfirmed,
      "Judul",
      "Isi pesan.",
    );

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      userId: "user_1",
      type: "registration_confirmed",
      title: "Judul",
      body: "Isi pesan.",
    });
  });

  it("throws (does not swallow) when the DB insert fails", async () => {
    const values = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { insert: vi.fn(() => ({ values })) } as never;

    await expect(
      writeNotification(db, "user_1", NOTIFICATION_TYPES.resultPublished, "T", "B"),
    ).rejects.toThrow("db down");
  });
});

// ── markNotificationAsRead ────────────────────────────────────────────────────

function makeReadDb(row: { id: string; readAt: Date | null } | null) {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(row ? [row] : []),
  };
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  let capturedSet: { readAt: Date } | undefined;
  const set = vi.fn((values: { readAt: Date }) => {
    capturedSet = values;
    return { where: updateWhere };
  });
  const db = {
    select: () => selectChain,
    update: vi.fn(() => ({ set })),
  } as never;
  return { db, updateWhere, set, getCapturedSet: () => capturedSet };
}

describe("markNotificationAsRead", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns found:false and does not write when the row is absent or owned by another user", async () => {
    // The lookup filters on id AND userId, so a foreign-owned row is indistinguishable from a
    // missing one — both surface as an empty result set.
    const { db, updateWhere } = makeReadDb(null);

    const result = await markNotificationAsRead("user_1", "notif_x", db);

    expect(result).toEqual({ found: false });
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("returns found:true without writing when already read (idempotent)", async () => {
    const { db, updateWhere } = makeReadDb({ id: "notif_1", readAt: new Date() });

    const result = await markNotificationAsRead("user_1", "notif_1", db);

    expect(result).toEqual({ found: true });
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("sets read_at and returns found:true for an unread owned notification", async () => {
    const { db, updateWhere, set, getCapturedSet } = makeReadDb({ id: "notif_1", readAt: null });

    const result = await markNotificationAsRead("user_1", "notif_1", db);

    expect(result).toEqual({ found: true });
    expect(set).toHaveBeenCalledOnce();
    expect(getCapturedSet()?.readAt).toBeInstanceOf(Date);
    expect(updateWhere).toHaveBeenCalledOnce();
  });
});

// ── deleteNotification ────────────────────────────────────────────────────────

function makeDeleteDb(deletedRows: { id: string }[]) {
  const returning = vi.fn().mockResolvedValue(deletedRows);
  const where = vi.fn(() => ({ returning }));
  const db = { delete: vi.fn(() => ({ where })) } as never;
  return { db, where, returning };
}

describe("deleteNotification", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns found:true when a row is deleted", async () => {
    const { db } = makeDeleteDb([{ id: "notif_1" }]);

    const result = await deleteNotification("user_1", "notif_1", db);

    expect(result).toEqual({ found: true });
  });

  it("returns found:false when nothing is deleted (absent or foreign-owned, no leak)", async () => {
    // The DELETE filters on id AND user_id, so a foreign-owned id removes nothing.
    const { db } = makeDeleteDb([]);

    const result = await deleteNotification("user_1", "notif_x", db);

    expect(result).toEqual({ found: false });
  });
});
