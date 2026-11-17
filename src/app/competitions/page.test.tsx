// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UIPrimitivesProvider } from "@/components/ui/primitives";

const { mockListPublicCompetitions } = vi.hoisted(() => ({
  mockListPublicCompetitions: vi.fn(),
}));

// Render a real <a> so renderToStaticMarkup does not need a router context.
vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/server/competitions/competition-public-service", () => ({
  listPublicCompetitions: mockListPublicCompetitions,
}));

import PublicCompetitionsPage from "./page";

const renderPage = async () => {
  mockListPublicCompetitions.mockResolvedValue({
    data: [],
    meta: { total: 0, page: 1, totalPages: 1 },
  });
  const page = await PublicCompetitionsPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(<UIPrimitivesProvider>{page}</UIPrimitivesProvider>);
};

describe("the competition list page", () => {
  afterEach(() => vi.clearAllMocks());

  it("has one visually hidden h1, Kompetisi, and no visible heading text above the search field", async () => {
    const html = await renderPage();

    expect(html).toContain('<h1 class="sr-only">Kompetisi</h1>');
    expect(html.split("<h1").length - 1).toBe(1);
    expect(html).not.toContain("Temukan kompetisi yang layak kamu kejar");
    expect(html).not.toContain("Cari berdasarkan judul, lalu saring arena");
  });

  it("puts the result count on its own line above the filter row", async () => {
    const html = await renderPage();

    const countAt = html.indexOf("0 kompetisi ditemukan");
    const rowAt = html.indexOf("filter-toolbar-filters");

    expect(countAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(countAt);
  });
});
