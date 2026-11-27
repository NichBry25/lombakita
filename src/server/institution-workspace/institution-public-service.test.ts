// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { SQL } from "drizzle-orm";
import { institutions } from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import {
  ANONYMOUS_INSTITUTION_VIEWER,
  getPublicInstitution,
} from "@/server/institution-workspace/institution-public-service";

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
  ...overrides,
});

// Records every predicate handed to `.where()`, because this fake resolves the rows the fixture
// gave it whatever the query says. That is fine for shaping assertions and useless for filtering
// ones — see the suspension test below.
const wherePredicates: SQL[] = [];

const makeDb = (selectResults: unknown[][]) => {
  wherePredicates.length = 0;
  let idx = 0;
  const node = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "limit"]) {
      n[m] = () => node();
    }
    n.where = (predicate: SQL) => {
      wherePredicates.push(predicate);
      return node();
    };
    n.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx++] ?? []);
    return n;
  };
  return { select: () => node() } as unknown as Database;
};

// Drizzle compiles a query without opening a connection and `.toSQL()` never executes, so a
// captured predicate can be read back as SQL with no database. Same mechanism as
// competitions/public-visibility-predicate.test.ts.
const compiledSql = (predicate: SQL): string =>
  drizzle(postgres("postgres://user:pass@127.0.0.1:1/unused", { max: 1 }))
    .select()
    .from(institutions)
    .where(predicate)
    .toSQL().sql;

describe("getPublicInstitution", () => {
  it("returns the public face of a full institution", async () => {
    const db = makeDb([[institutionRow()], [{ platform: "linkedin", url: "https://li/x" }]]);

    const institution = await getPublicInstitution(
      "kampus-merdeka",
      ANONYMOUS_INSTITUTION_VIEWER,
      db,
    );

    expect(institution).toMatchObject({
      slug: "kampus-merdeka",
      name: "Kampus Merdeka",
      isVerified: true,
      logoUrl: "https://r2.example/get/institution-logos/inst_1/logo.png",
      bannerUrl: "https://r2.example/get/institution-banners/inst_1/banner.jpg",
    });
    expect(institution?.socialLinks).toEqual([{ platform: "linkedin", url: "https://li/x" }]);
  });

  it("reports unverified status rather than omitting the institution", async () => {
    const db = makeDb([[institutionRow({ verificationStatus: "pending_verification" })], []]);

    expect(
      (await getPublicInstitution("kampus-merdeka", ANONYMOUS_INSTITUTION_VIEWER, db))?.isVerified,
    ).toBe(false);
  });

  it("returns the public face of a personal workspace with its own images and links", async () => {
    const db = makeDb([
      [
        institutionRow({
          institutionType: "personal",
          slug: "lomba-budi",
          displayName: "Lomba Budi",
          verificationStatus: "pending_verification",
        }),
      ],
      [{ platform: "instagram", url: "https://ig.example/lomba-budi" }],
    ]);

    const institution = await getPublicInstitution("lomba-budi", ANONYMOUS_INSTITUTION_VIEWER, db);

    expect(institution).toMatchObject({
      slug: "lomba-budi",
      name: "Lomba Budi",
      institutionType: "personal",
      isVerified: false,
      logoUrl: "https://r2.example/get/institution-logos/inst_1/logo.png",
      bannerUrl: "https://r2.example/get/institution-banners/inst_1/banner.jpg",
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      contactDisclosure: { kind: "hidden" },
    });
    expect(institution?.socialLinks).toEqual([
      { platform: "instagram", url: "https://ig.example/lomba-budi" },
    ]);
    expect(institution).not.toHaveProperty("personalOwnerUsername");
  });

  // Suspension used to be a JavaScript check on the returned row, and this asserted the returned
  // value was null. It is now a WHERE clause, which this fake db ignores — so the old assertion
  // could not fail however the filter were broken, and asserting the SQL is the only thing left
  // that can. That the DATABASE then honours the clause is proven in
  // src/app/sitemap-db.integration.test.ts against real Postgres, where the same suspended
  // organizer is required to be absent from its own page and from the sitemap alike.
  it("asks the database to withhold a suspended institution rather than filtering afterwards", async () => {
    await getPublicInstitution(
      "kampus-merdeka",
      ANONYMOUS_INSTITUTION_VIEWER,
      makeDb([[institutionRow()], []]),
    );

    expect(wherePredicates).toHaveLength(2);
    expect(compiledSql(wherePredicates[0]!)).toContain('"institutions"."suspended_at" is null');
  });

  it("returns null for an unknown slug", async () => {
    expect(
      await getPublicInstitution("tidak-ada", ANONYMOUS_INSTITUTION_VIEWER, makeDb([[]])),
    ).toBeNull();
  });
});
