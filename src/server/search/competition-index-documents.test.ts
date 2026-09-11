// @vitest-environment node

/**
 * What a competition row becomes in the index.
 *
 * This mapping is consumed by the publish/edit sync job AND by every full rebuild, which is the
 * reason it was extracted: written out separately they drift, and the index then disagrees with
 * itself depending on which path last touched a row, with each side individually correct. These
 * tests pin the shape both paths now share.
 */

import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  COMPETITION_INDEX_COLUMNS,
  publishedCompetitionsFilter,
  toCompetitionIndexDocument,
  type CompetitionIndexRow,
} from "@/server/search/competition-index-documents";
import { competitions } from "@/server/db/schema";

const row = (overrides: Partial<CompetitionIndexRow> = {}): CompetitionIndexRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Lomba Robotik Nasional",
  slug: "lomba-robotik-nasional",
  category: "technology",
  mode: "team",
  registrationEndAt: new Date("2026-11-30T17:00:00.000Z"),
  createdAt: new Date("2026-09-01T03:00:00.000Z"),
  isFeatured: false,
  featuredOrder: null,
  institutionSlug: "itb",
  institutionDisplayName: "Institut Teknologi Bandung",
  institutionType: "university",
  institutionOwnerUsername: null,
  ...overrides,
});

describe("toCompetitionIndexDocument", () => {
  it("maps a full institution's competition", () => {
    expect(toCompetitionIndexDocument(row())).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Lomba Robotik Nasional",
      slug: "lomba-robotik-nasional",
      category: "technology",
      mode: "team",
      deadline: 1796058000,
      createdAt: "2026-09-01T03:00:00.000Z",
      isFeatured: false,
      featuredOrder: null,
      institutionSlug: "itb",
      institutionName: "Institut Teknologi Bandung",
      status: "published",
    });
  });

  // UNIX SECONDS, not milliseconds. Meilisearch range-filters this field numerically, so a
  // millisecond value is not a wrong-looking date — it is a deadline a thousand times further out,
  // and every "closing soon" filter silently stops matching.
  it("writes the deadline as UNIX epoch seconds", () => {
    const document = toCompetitionIndexDocument(
      row({ registrationEndAt: new Date("2026-01-01T00:00:00.000Z") }),
    );

    expect(document.deadline).toBe(1767225600);
    expect(document.deadline).toBe(
      Math.floor(new Date("2026-01-01T00:00:00.000Z").getTime() / 1000),
    );
  });

  // A competition that never closes. Null is not zero: zero is 1970, which sorts first and reads
  // as long expired.
  it("carries a null deadline rather than a zero", () => {
    expect(toCompetitionIndexDocument(row({ registrationEndAt: null })).deadline).toBeNull();
  });

  // THE BRANCH A REBUILD WOULD MOST EASILY GET WRONG. A personal institution stores NULL in
  // display_name and derives its name from the owner's username. Reading the raw column here puts
  // an empty name on every personal institution's competitions in search.
  it("resolves a personal institution's name from the owner username", () => {
    const document = toCompetitionIndexDocument(
      row({
        institutionType: "personal",
        institutionDisplayName: null,
        institutionOwnerUsername: "raka",
      }),
    );

    expect(document.institutionName).toBe("raka's Institution");
  });

  it("falls back to a stable name when a personal institution has no resolvable owner", () => {
    const document = toCompetitionIndexDocument(
      row({
        institutionType: "personal",
        institutionDisplayName: null,
        institutionOwnerUsername: null,
      }),
    );

    expect(document.institutionName).toBe("Personal Institution");
  });

  it("keeps featured ordering", () => {
    const document = toCompetitionIndexDocument(row({ isFeatured: true, featuredOrder: 3 }));

    expect(document.isFeatured).toBe(true);
    expect(document.featuredOrder).toBe(3);
  });

  it("normalises absent category and mode to null", () => {
    const document = toCompetitionIndexDocument(row({ category: null, mode: null }));

    expect(document.category).toBeNull();
    expect(document.mode).toBeNull();
  });

  // Only published rows are ever selected, and the document says so unconditionally rather than
  // copying a status column that could carry anything.
  it("always stamps the document published", () => {
    expect(toCompetitionIndexDocument(row()).status).toBe("published");
  });
});

/**
 * The whole document, for every branch the mapping has.
 *
 * This module replaced three separately written copies of the same mapping, and the equivalence of
 * those copies was established by running all four over these variants and comparing the output.
 * That comparison is gone the moment the old code is gone, so what it proved is pinned here
 * instead: each variant asserts the COMPLETE document rather than the one field it exercises, so a
 * change to any branch fails somewhere even if the variant that targets it is not the one edited.
 *
 * The variants are the branches, not a sample: null and present category/mode/featuredOrder, the
 * three date cases that `Math.floor(getTime() / 1000)` treats differently, and every path through
 * `getInstitutionDisplayName`.
 */
describe("the document, across every branch of the mapping", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Lomba Robotik Nasional",
    slug: "lomba-robotik-nasional",
    isFeatured: false,
    institutionSlug: "itb",
    status: "published" as const,
  };

  const cases: [string, Partial<CompetitionIndexRow>, Record<string, unknown>][] = [
    ["a full row", {}, {}],
    ["absent category", { category: null }, { category: null }],
    ["absent mode", { mode: null }, { mode: null }],
    [
      "absent featured order",
      { isFeatured: true, featuredOrder: null },
      { isFeatured: true, featuredOrder: null },
    ],
    [
      "a present featured order",
      { isFeatured: true, featuredOrder: 3 },
      { isFeatured: true, featuredOrder: 3 },
    ],
    ["no deadline at all", { registrationEndAt: null }, { deadline: null }],
    // Epoch zero is the case `??` and truthiness disagree about: a Date at 0ms is truthy, but a
    // mapping written with `?? null` on the NUMBER would turn a real deadline into null.
    ["a deadline at epoch zero", { registrationEndAt: new Date(0) }, { deadline: 0 }],
    [
      "a deadline before epoch",
      { registrationEndAt: new Date(-86_400_000) },
      { deadline: -86_400 },
    ],
    // Sub-second precision floors rather than rounds, so a deadline never moves forward.
    [
      "a deadline with milliseconds",
      { registrationEndAt: new Date(1_700_000_000_999) },
      { deadline: 1_700_000_000 },
    ],
    [
      "a personal institution with a resolvable owner",
      {
        institutionType: "personal",
        institutionDisplayName: null,
        institutionOwnerUsername: "rara",
      },
      { institutionName: "rara's Institution" },
    ],
    [
      "a personal institution with no resolvable owner",
      { institutionType: "personal", institutionDisplayName: null, institutionOwnerUsername: null },
      { institutionName: "Personal Institution" },
    ],
    // A NULL type is a legacy FULL institution, so it reads the display name rather than deriving
    // one from the owner, even when an owner username is present.
    [
      "a legacy institution with a null type",
      { institutionType: null, institutionDisplayName: "ITB", institutionOwnerUsername: "rara" },
      { institutionName: "ITB" },
    ],
    [
      "a full institution whose display name is empty",
      { institutionDisplayName: "", institutionOwnerUsername: "rara" },
      { institutionName: "" },
    ],
  ];

  it.each(cases)("maps %s", (_name, overrides, expected) => {
    const source = row(overrides);

    expect(toCompetitionIndexDocument(source)).toEqual({
      ...base,
      category: source.category,
      mode: source.mode,
      deadline: source.registrationEndAt
        ? Math.floor(source.registrationEndAt.getTime() / 1000)
        : null,
      createdAt: source.createdAt.toISOString(),
      featuredOrder: source.featuredOrder,
      institutionName: source.institutionDisplayName ?? "",
      ...expected,
    });
  });
});

/**
 * Which rows a rebuild is allowed to put in the index.
 *
 * The document hardcodes `status: "published"`, which is only sound while this filter is the sole
 * producer. Nothing failed if the filter started admitting drafts or soft-deleted rows: a rebuild
 * would have stamped them published and pushed the lot into every search result at once. Both
 * halves of the predicate are pinned here because both are load-bearing and neither is obvious
 * from the document shape.
 *
 * postgres-js connects lazily and `.toSQL()` never executes, so nothing here touches a database.
 */
describe("publishedCompetitionsFilter", () => {
  const compiled = () => {
    const db = drizzle(postgres("postgres://user:pass@127.0.0.1:1/unused", { max: 1 }));

    return db.select().from(competitions).where(publishedCompetitionsFilter()).toSQL();
  };

  it("restricts a rebuild to published rows", () => {
    const { sql, params } = compiled();

    expect(sql).toContain('"competitions"."status" = ');
    expect(params).toContain("published");
  });

  it("excludes soft-deleted rows", () => {
    expect(compiled().sql).toContain('"competitions"."deleted_at" is null');
  });
});

/**
 * The column set the index is built from.
 *
 * Pinned as a set rather than described in prose: a column added here without a matching document
 * field is selected and silently dropped, and one removed breaks a document field with no other
 * warning.
 */
describe("COMPETITION_INDEX_COLUMNS", () => {
  it("selects exactly the columns the document is built from", () => {
    expect(Object.keys(COMPETITION_INDEX_COLUMNS).sort()).toEqual(
      [
        "id",
        "title",
        "slug",
        "category",
        "mode",
        "registrationEndAt",
        "createdAt",
        "isFeatured",
        "featuredOrder",
        "institutionSlug",
        "institutionDisplayName",
        "institutionType",
        "institutionOwnerUsername",
      ].sort(),
    );
  });
});
