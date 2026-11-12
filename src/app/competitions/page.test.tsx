// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockListPublicCompetitions } = vi.hoisted(() => ({
  mockListPublicCompetitions: vi.fn(),
}));

// Render a real <a> so renderToStaticMarkup can assert href attributes without a router context.
vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});
// The search form and filter row are client controls with their own tests; this file is about
// what the page says when nothing comes back.
vi.mock("./competition-search-form", () => ({ CompetitionSearchForm: () => null }));
vi.mock("./competition-filter-bar", () => ({ CompetitionFilterBar: () => null }));
vi.mock("@/server/competitions/competition-public-service", () => ({
  listPublicCompetitions: mockListPublicCompetitions,
}));

import PublicCompetitionsPage from "@/app/competitions/page";

const emptyListing = {
  data: [],
  meta: { total: 0, page: 1, limit: 20, totalPages: 0, searchEngine: "db" as const },
};

const renderWith = async (searchParams: Record<string, string>) =>
  renderToStaticMarkup(
    await PublicCompetitionsPage({ searchParams: Promise.resolve(searchParams) }),
  );

describe("PublicCompetitionsPage empty states", () => {
  afterEach(() => vi.clearAllMocks());

  it("says the catalogue is coming when nothing is published and nothing was filtered", async () => {
    mockListPublicCompetitions.mockResolvedValue(emptyListing);

    const html = await renderWith({});

    expect(html).toContain("Kompetisi pertama segera tayang.");
    expect(html).toContain('href="/#minat"');
    expect(html).not.toContain("Bersihkan filter");
  });

  it("offers to clear the filters when a filtered search finds nothing", async () => {
    mockListPublicCompetitions.mockResolvedValue(emptyListing);

    const html = await renderWith({ category: "debate" });

    expect(html).toContain("Belum ada hasil yang cocok.");
    expect(html).toContain("Bersihkan filter");
    expect(html).not.toContain("Kompetisi pertama segera tayang.");
  });
});
