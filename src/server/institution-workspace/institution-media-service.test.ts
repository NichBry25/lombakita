// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { InstitutionProfileInputError } from "@/server/institution-workspace/institution-profile-core";
import {
  deleteInstitutionMedia,
  generateInstitutionMediaUploadUrl,
  recordInstitutionMedia,
} from "@/server/institution-workspace/institution-media-service";

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  generatePresignedPutUrl: vi.fn(async (key: string) => `https://r2.example/put/${key}`),
}));

const ownerRow = (overrides: Record<string, unknown> = {}) => ({
  institutionId: "inst_1",
  institutionDisplayName: "Kampus Merdeka",
  institutionSlug: "kampus-merdeka",
  institutionStatus: "active",
  institutionType: "university",
  institutionDescription: null,
  institutionCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
  institutionUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
  membershipId: "mem_1",
  membershipRole: "institution_owner",
  membershipStatus: "active",
  membershipJoinedAt: new Date("2026-07-01T00:00:00.000Z"),
  ownerUsername: "alice",
  ...overrides,
});

// Mirrors the select/update thenable shape used across the institution-service suite, and records
// every update so a test can assert that a step wrote nothing at all.
const makeDb = (selectResults: unknown[][]) => {
  let idx = 0;
  const updates: Array<Record<string, unknown>> = [];
  const node = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
      n[m] = () => node();
    }
    n.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx++] ?? []);
    return n;
  };
  const db = {
    select: () => node(),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => node() };
      },
    }),
  } as unknown as Database;
  return { db, updates };
};

describe("generateInstitutionMediaUploadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  // The defect this two-step flow exists to fix: the old one-step upload stored the key before the
  // browser had uploaded anything, so an abandoned upload left the column pointing at a missing
  // object — with the previous image already discarded.
  it("writes nothing to the database when minting an upload URL", async () => {
    const { db, updates } = makeDb([[ownerRow()]]);

    const grant = await generateInstitutionMediaUploadUrl(
      "user_1",
      "kampus-merdeka",
      "logo",
      { contentType: "image/png" },
      db,
    );

    expect(updates).toEqual([]);
    expect(grant.fileKey).toMatch(/^institution-logos\/inst_1\//);
    expect(grant.uploadUrl).toContain(grant.fileKey);
  });

  it("namespaces banners separately from logos", async () => {
    const { db } = makeDb([[ownerRow()]]);

    const grant = await generateInstitutionMediaUploadUrl(
      "user_1",
      "kampus-merdeka",
      "banner",
      { contentType: "image/jpeg" },
      db,
    );

    expect(grant.fileKey).toMatch(/^institution-banners\/inst_1\//);
  });

  it("refuses a personal institution, which shows its owner's imagery instead", async () => {
    const { db, updates } = makeDb([[ownerRow({ institutionType: "personal" })]]);

    await expect(
      generateInstitutionMediaUploadUrl(
        "user_1",
        "alice",
        "banner",
        { contentType: "image/png" },
        db,
      ),
    ).rejects.toMatchObject({ code: "institution_profile_not_editable", httpStatus: 403 });
    expect(updates).toEqual([]);
  });

  it("refuses a caller who does not own the institution", async () => {
    const { db } = makeDb([[], []]);

    await expect(
      generateInstitutionMediaUploadUrl(
        "user_2",
        "kampus-merdeka",
        "logo",
        { contentType: "image/png" },
        db,
      ),
    ).rejects.toThrow();
  });
});

describe("recordInstitutionMedia", () => {
  it("stores a key scoped to the institution", async () => {
    const { db, updates } = makeDb([[ownerRow()]]);

    await recordInstitutionMedia(
      "user_1",
      "kampus-merdeka",
      "logo",
      "institution-logos/inst_1/abc",
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ logoR2Key: "institution-logos/inst_1/abc" });
  });

  it("writes the banner column for a banner, never the logo column", async () => {
    const { db, updates } = makeDb([[ownerRow()]]);

    await recordInstitutionMedia(
      "user_1",
      "kampus-merdeka",
      "banner",
      "institution-banners/inst_1/abc",
      db,
    );

    expect(updates[0]).toMatchObject({ bannerR2Key: "institution-banners/inst_1/abc" });
    expect(updates[0]).not.toHaveProperty("logoR2Key");
  });

  // The prefix check is the ownership boundary — without it a caller could point their own
  // institution at another institution's stored object.
  it("rejects a key scoped to a different institution", async () => {
    const { db, updates } = makeDb([[ownerRow()]]);

    await expect(
      recordInstitutionMedia(
        "user_1",
        "kampus-merdeka",
        "logo",
        "institution-logos/inst_999/abc",
        db,
      ),
    ).rejects.toBeInstanceOf(InstitutionProfileInputError);
    expect(updates).toEqual([]);
  });

  it("rejects a key belonging to the other media kind", async () => {
    const { db, updates } = makeDb([[ownerRow()]]);

    await expect(
      recordInstitutionMedia(
        "user_1",
        "kampus-merdeka",
        "banner",
        "institution-logos/inst_1/abc",
        db,
      ),
    ).rejects.toBeInstanceOf(InstitutionProfileInputError);
    expect(updates).toEqual([]);
  });
});

describe("deleteInstitutionMedia", () => {
  it("clears the requested column", async () => {
    const { db, updates } = makeDb([[ownerRow()]]);

    await deleteInstitutionMedia("user_1", "kampus-merdeka", "banner", db);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ bannerR2Key: null });
  });
});
