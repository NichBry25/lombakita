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
import {
  toCompetitionIndexDocument,
  type CompetitionIndexRow,
} from "@/server/search/competition-index-documents";

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
