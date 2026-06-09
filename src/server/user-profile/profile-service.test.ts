// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { ProfileInputError, type ProfilePatch } from "@/server/user-profile/profile-core";

// Step 6.5f.1 (post-step-9) — the personal-institution slug rewrite and the institution-slug
// collision guard live in institution-service; this test isolates the profile-service wiring
// (ordering, rejection, and post-commit search-sync enqueue) by mocking those helpers.
const {
  findOwnedPersonalInstitution,
  usernameCollidesWithInstitutionSlug,
  rewritePersonalInstitutionSlugForUsername,
  enqueueCompetitionSearchSync,
} = vi.hoisted(() => ({
  findOwnedPersonalInstitution: vi.fn(),
  usernameCollidesWithInstitutionSlug: vi.fn(),
  rewritePersonalInstitutionSlugForUsername: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/server/institution-workspace/institution-service", () => ({
  findOwnedPersonalInstitution,
  usernameCollidesWithInstitutionSlug,
  rewritePersonalInstitutionSlugForUsername,
}));

vi.mock("@/server/async/enqueue", () => ({ enqueueCompetitionSearchSync }));

import { updateOwnerProfile } from "@/server/user-profile/profile-service";

const profileRow = (username: string) => ({
  id: "user_1",
  username,
  email: "user@example.com",
  role: "recruiter",
  candidateVerifiedAt: null,
  recruiterVerifiedAt: new Date("2026-06-01T00:00:00.000Z"),
  displayName: null,
  summary: null,
  location: null,
  avatarUrl: null,
  university: null,
  major: null,
  graduationYear: null,
  roleTitle: null,
  organizationName: null,
  websiteUrl: null,
});

// selectResults are consumed in call order: isUsernameTaken first, then getOwnerProfile's final read.
const makeProfileDb = (selectResults: unknown[][]) => {
  let idx = 0;
  const selectNode = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where"]) {
      n[m] = () => n;
    }
    n.limit = async () => selectResults[idx++] ?? [];
    return n;
  };

  const txUpdate = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  const txInsert = vi.fn(() => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }));
  const tx = { update: txUpdate, insert: txInsert };

  const db = {
    select: () => selectNode(),
    transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  } as unknown as Database;

  return { db, txUpdate, txInsert };
};

describe("updateOwnerProfile — personal institution slug sync (Step 6.5f.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueCompetitionSearchSync.mockResolvedValue({});
  });

  it("Fix A happy path: rewrites the personal slug and re-syncs published competitions", async () => {
    findOwnedPersonalInstitution.mockResolvedValue({ institutionId: "inst_1", slug: "alice" });
    usernameCollidesWithInstitutionSlug.mockResolvedValue(false);
    rewritePersonalInstitutionSlugForUsername.mockResolvedValue(["comp_1", "comp_2"]);

    const { db, txUpdate } = makeProfileDb([[], [profileRow("bob")]]);

    await updateOwnerProfile("user_1", { username: "bob" } as ProfilePatch, db);

    expect(rewritePersonalInstitutionSlugForUsername).toHaveBeenCalledWith(
      "inst_1",
      "bob",
      expect.anything(),
    );
    expect(txUpdate).toHaveBeenCalled();
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledTimes(2);
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledWith({
      competitionId: "comp_1",
      action: "upsert",
    });
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledWith({
      competitionId: "comp_2",
      action: "upsert",
    });
  });

  it("no personal institution: candidate username change writes no institution row and raises no error", async () => {
    findOwnedPersonalInstitution.mockResolvedValue(null);
    usernameCollidesWithInstitutionSlug.mockResolvedValue(false);

    const { db, txUpdate } = makeProfileDb([[], [profileRow("carol")]]);

    await expect(
      updateOwnerProfile("user_1", { username: "carol" } as ProfilePatch, db),
    ).resolves.toBeDefined();

    expect(rewritePersonalInstitutionSlugForUsername).not.toHaveBeenCalled();
    expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalled();
  });

  it("Fix B: rejects a username that collides with another institution's slug; username unchanged", async () => {
    findOwnedPersonalInstitution.mockResolvedValue(null);
    usernameCollidesWithInstitutionSlug.mockResolvedValue(true);

    const { db, txUpdate } = makeProfileDb([[]]);

    await expect(
      updateOwnerProfile("user_1", { username: "universitas-indonesia" } as ProfilePatch, db),
    ).rejects.toMatchObject({ code: "profile_username_conflicts_with_institution" });

    expect(rewritePersonalInstitutionSlugForUsername).not.toHaveBeenCalled();
    expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
    // Rejection fires before the users-table update, so the username is never written.
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("no-op self-match: rewriting to the same username succeeds and enqueues nothing", async () => {
    findOwnedPersonalInstitution.mockResolvedValue({ institutionId: "inst_1", slug: "alice" });
    usernameCollidesWithInstitutionSlug.mockResolvedValue(false);
    rewritePersonalInstitutionSlugForUsername.mockResolvedValue([]);

    const { db } = makeProfileDb([[], [profileRow("alice")]]);

    await expect(
      updateOwnerProfile("user_1", { username: "alice" } as ProfilePatch, db),
    ).resolves.toBeDefined();

    expect(rewritePersonalInstitutionSlugForUsername).toHaveBeenCalledTimes(1);
    expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
  });

  it("rethrows the rejection as a ProfileInputError (mapped to 409 at the route layer)", async () => {
    findOwnedPersonalInstitution.mockResolvedValue(null);
    usernameCollidesWithInstitutionSlug.mockResolvedValue(true);

    const { db } = makeProfileDb([[]]);

    await expect(
      updateOwnerProfile("user_1", { username: "kampus" } as ProfilePatch, db),
    ).rejects.toBeInstanceOf(ProfileInputError);
  });
});
