// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { ProfileInputError, type ProfilePatch } from "@/server/user-profile/profile-core";

// The institution-slug collision check lives in institution-service. This test isolates when the
// profile service runs it and how its refusal surfaces, by mocking it.
const { usernameCollidesWithInstitutionSlug, enqueueCompetitionSearchSync } = vi.hoisted(() => ({
  usernameCollidesWithInstitutionSlug: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/server/institution-workspace/institution-service", () => ({
  usernameCollidesWithInstitutionSlug,
}));

vi.mock("@/server/async/enqueue", () => ({ enqueueCompetitionSearchSync }));

import { updateOwnerProfile } from "@/server/user-profile/profile-service";

// selectResults are consumed in call order (by `.limit`): isUsernameTaken first, then the
// stored-username read inside the transaction, then getOwnerProfile's final scalar read. The
// collection reads in getOwnerProfile terminate on `.orderBy` and always resolve to [] here — they
// do not consume from selectResults.
const makeProfileDb = (selectResults: unknown[][]) => {
  let idx = 0;
  const selectNode = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where"]) {
      n[m] = () => n;
    }
    n.limit = async () => selectResults[idx++] ?? [];
    n.orderBy = async () => [];
    return n;
  };

  const txUpdate = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  const txInsert = vi.fn(() => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }));
  const tx = { update: txUpdate, insert: txInsert, select: () => selectNode() };

  const db = {
    select: () => selectNode(),
    transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  } as unknown as Database;

  return { db, txUpdate, txInsert };
};

describe("updateOwnerProfile and the workspace slugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueCompetitionSearchSync.mockResolvedValue({});
  });

  it("Fix B: rejects a username that collides with another institution's slug; username unchanged", async () => {
    usernameCollidesWithInstitutionSlug.mockResolvedValue(true);

    const { db, txUpdate } = makeProfileDb([[], [{ username: "alice" }]]);

    await expect(
      updateOwnerProfile("user_1", { username: "universitas-indonesia" } as ProfilePatch, db),
    ).rejects.toMatchObject({ code: "profile_username_conflicts_with_institution" });

    expect(usernameCollidesWithInstitutionSlug).toHaveBeenCalledWith(
      "universitas-indonesia",
      expect.anything(),
    );
    expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
    // Rejection fires before the users-table update, so the username is never written.
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("rethrows the rejection as a ProfileInputError (mapped to 409 at the route layer)", async () => {
    usernameCollidesWithInstitutionSlug.mockResolvedValue(true);

    const { db } = makeProfileDb([[], [{ username: "alice" }]]);

    await expect(
      updateOwnerProfile("user_1", { username: "kampus" } as ProfilePatch, db),
    ).rejects.toBeInstanceOf(ProfileInputError);
  });
});
