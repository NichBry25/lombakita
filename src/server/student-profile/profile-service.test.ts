// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { updateStudentProfileForUser } from "@/server/student-profile/profile-service";

type StudentProfileRowFixture = {
  userId: string;
  email: string;
  accountName: string | null;
  profileDisplayName: string | null;
  profilePhoneNumber: string | null;
  profileSummary: string | null;
  profileCreatedAt: Date | null;
  profileUpdatedAt: Date | null;
};

const createDbMock = (row: StudentProfileRowFixture) => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const whereUpdate = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));

  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));

  const tx = {
    insert,
    update,
  };

  const transaction = vi.fn(async (callback: (context: typeof tx) => Promise<void>) => {
    await callback(tx);
  });

  return {
    db: {
      transaction,
      select,
    } as unknown as Database,
    spies: {
      transaction,
      insert,
      values,
      onConflictDoUpdate,
      update,
      set,
      whereUpdate,
      select,
      from,
      leftJoin,
      where,
      limit,
    },
  };
};

describe("updateStudentProfileForUser", () => {
  it("syncs users.name when displayName is updated", async () => {
    const { db, spies } = createDbMock({
      userId: "student_1",
      email: "student@example.com",
      accountName: "Nama Lama",
      profileDisplayName: "Nama Baru",
      profilePhoneNumber: "+628111222333",
      profileSummary: "Aktif ikut lomba produk digital.",
      profileCreatedAt: new Date("2026-04-10T10:00:00.000Z"),
      profileUpdatedAt: new Date("2026-04-16T00:00:00.000Z"),
    });

    const profile = await updateStudentProfileForUser(
      "student_1",
      {
        displayName: "Nama Baru",
        phoneNumber: "+628111222333",
      },
      db,
    );

    expect(spies.transaction).toHaveBeenCalledTimes(1);
    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Nama Baru",
      }),
    );
    expect(profile.displayName).toBe("Nama Baru");
  });

  it("does not update users.name when displayName is not provided", async () => {
    const { db, spies } = createDbMock({
      userId: "student_1",
      email: "student@example.com",
      accountName: "Nama Tetap",
      profileDisplayName: "Nama Tetap",
      profilePhoneNumber: "+628444555666",
      profileSummary: null,
      profileCreatedAt: new Date("2026-04-10T10:00:00.000Z"),
      profileUpdatedAt: new Date("2026-04-16T00:10:00.000Z"),
    });

    const profile = await updateStudentProfileForUser(
      "student_1",
      {
        phoneNumber: "+628444555666",
      },
      db,
    );

    expect(spies.transaction).toHaveBeenCalledTimes(1);
    expect(spies.update).not.toHaveBeenCalled();
    expect(profile.displayName).toBe("Nama Tetap");
  });
});
