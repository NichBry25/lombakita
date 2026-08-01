// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { getPublicInstitution } from "@/server/institution-workspace/institution-public-service";

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  generatePresignedGetUrl: vi.fn(async (key: string) => `https://r2.example/get/${key}`),
}));

const institutionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "inst_1",
  slug: "kampus-merdeka",
  displayName: "Kampus Merdeka",
  institutionType: "university",
  description: "Penyelenggara kompetisi mahasiswa.",
  about: "Tentang kami.",
  verificationStatus: "verified",
  suspendedAt: null,
  logoR2Key: "institution-logos/inst_1/logo.png",
  bannerR2Key: "institution-banners/inst_1/banner.jpg",
  contactName: "Budi",
  contactEmail: "budi@kampus.ac.id",
  contactPhone: "0800",
  websiteUrl: "https://kampus.ac.id",
  ownerUsername: "alice",
  ownerAvatarKey: "avatars/u_1/avatar.jpg",
  ownerBannerKey: "banners/u_1/banner.jpg",
  ...overrides,
});

const makeDb = (selectResults: unknown[][]) => {
  let idx = 0;
  const node = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
      n[m] = () => node();
    }
    n.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx++] ?? []);
    return n;
  };
  return { select: () => node() } as unknown as Database;
};

describe("getPublicInstitution", () => {
  it("returns the public face of a full institution", async () => {
    const db = makeDb([[institutionRow()], [{ platform: "linkedin", url: "https://li/x" }]]);

    const institution = await getPublicInstitution("kampus-merdeka", db);

    expect(institution).toMatchObject({
      slug: "kampus-merdeka",
      name: "Kampus Merdeka",
      isVerified: true,
      logoUrl: "https://r2.example/get/institution-logos/inst_1/logo.png",
      bannerUrl: "https://r2.example/get/institution-banners/inst_1/banner.jpg",
      personalOwnerUsername: null,
    });
    expect(institution?.socialLinks).toEqual([{ platform: "linkedin", url: "https://li/x" }]);
  });

  it("reports unverified status rather than omitting the institution", async () => {
    const db = makeDb([[institutionRow({ verificationStatus: "pending_verification" })], []]);

    expect((await getPublicInstitution("kampus-merdeka", db))?.isVerified).toBe(false);
  });

  // A personal institution's page is a redirect to its owner, so the caller needs the username and
  // nothing else — imagery and contact details would only be rendered by a page that never renders.
  it("returns the owner username for a personal institution and withholds its detail", async () => {
    const db = makeDb([
      [
        institutionRow({
          institutionType: "personal",
          slug: "alice",
          displayName: null,
          logoR2Key: null,
          bannerR2Key: null,
        }),
      ],
    ]);

    const institution = await getPublicInstitution("alice", db);

    expect(institution).toMatchObject({
      institutionType: "personal",
      personalOwnerUsername: "alice",
      logoUrl: null,
      bannerUrl: null,
      contactEmail: null,
    });
    expect(institution?.socialLinks).toEqual([]);
  });

  it("withholds a suspended institution entirely", async () => {
    const db = makeDb([[institutionRow({ suspendedAt: new Date("2026-07-01T00:00:00.000Z") })]]);

    expect(await getPublicInstitution("kampus-merdeka", db)).toBeNull();
  });

  it("returns null for an unknown slug", async () => {
    expect(await getPublicInstitution("tidak-ada", makeDb([[]]))).toBeNull();
  });
});
