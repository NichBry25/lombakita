// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockListFeaturedCompetitions, mockListPublicCompetitions, mockLoggerError } = vi.hoisted(
  () => ({
    mockListFeaturedCompetitions: vi.fn(),
    mockListPublicCompetitions: vi.fn(),
    mockLoggerError: vi.fn(),
  }),
);

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
vi.mock("@/server/competitions/competition-public-service", () => ({
  listFeaturedCompetitions: mockListFeaturedCompetitions,
  listPublicCompetitions: mockListPublicCompetitions,
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import HomePage from "@/app/(home)/page";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");

const featuredItem = (n: number) => ({
  id: `comp_${n}`,
  slug: `featured-${n}`,
  title: `Kompetisi Unggulan ${n}`,
  description: "Deskripsi kompetisi.",
  category: "hackathon" as const,
  mode: "individual" as const,
  minTeamSize: null,
  maxTeamSize: null,
  registrationStartAt: NOW,
  registrationEndAt: FUTURE,
  eventStartAt: FUTURE,
  eventEndAt: FUTURE,
  publishedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  isFeatured: true,
  institutionSlug: "ui",
  institutionName: "Universitas Indonesia",
});

const listing = (data: ReturnType<typeof featuredItem>[]) => ({
  data,
  meta: { total: data.length, page: 1, limit: 50, totalPages: 1, searchEngine: "db" as const },
});

// Routes the two row reads by the filters the page passes, so a test can fill one row and not the
// other.
const mockShelves = ({
  closing = [],
  pool = [],
}: {
  closing?: ReturnType<typeof featuredItem>[];
  pool?: ReturnType<typeof featuredItem>[];
}) =>
  mockListPublicCompetitions.mockImplementation(async (filters: { status?: string }) =>
    listing(filters.status === "closing" ? closing : pool),
  );

describe("HomePage", () => {
  beforeEach(() => {
    mockShelves({});
  });
  afterEach(() => vi.clearAllMocks());

  it("renders the hero and discovery sections with featured competitions present", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1), featuredItem(2)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(mockListFeaturedCompetitions).toHaveBeenCalledWith(4);
    expect(html).toContain("Temukan kompetisi yang");
    expect(html).toContain("Mulai mencari");
  });

  it("renders the featured carousel section when featured competitions exist", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Kompetisi Unggulan 1");
    expect(html).toContain("Kompetisi ternama");
  });

  it("renders cleanly with no broken carousel when there are no featured competitions", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).not.toContain("Kompetisi ternama");
    expect(html).not.toContain("featured-carousel");
    // Rest of the page still renders.
    expect(html).toContain("Pilih arenamu");
  });

  it("degrades to no featured rail — and records the failure — when the fetch throws", async () => {
    mockListFeaturedCompetitions.mockRejectedValue(new Error("db unavailable"));

    // The decorative featured rail failing must not take down the whole public homepage.
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Temukan kompetisi yang");
    expect(html).toContain("Pilih arenamu");
    expect(html).not.toContain("Kompetisi ternama");

    // Degraded, but not silently — the failure is logged for observability.
    expect(mockLoggerError).toHaveBeenCalledWith(
      "home.featured-competitions.load-failed",
      expect.objectContaining({ error: "db unavailable" }),
    );
  });

  it("sends each arena card to the listing already filtered to that arena", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain('href="/competitions?category=hackathon"');
    expect(html).toContain('href="/competitions?category=scientific_writing"');
  });

  it("fills the closing-soon, newest and arena rows from the live listing", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);
    mockShelves({
      closing: [{ ...featuredItem(7), title: "Lomba Hampir Tutup" }],
      pool: [featuredItem(1), { ...featuredItem(2), category: "business" as never }],
    });

    const html = renderToStaticMarkup(await HomePage());

    expect(mockListPublicCompetitions).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closing", sort: "deadline_asc" }),
    );
    expect(html).toContain("Segera ditutup");
    expect(html).toContain("Lomba Hampir Tutup");
    expect(html).toContain("Kompetisi terbaru");
    // One row per arena that has something open, linked to that arena's full listing.
    expect(html).toContain('href="/competitions?category=business"');
    expect(html).not.toContain("Kompetisi pertama sedang dikurasi");
  });

  it("says the catalogue is being prepared when nothing is live, instead of showing empty rows", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Kompetisi pertama sedang dikurasi");
    expect(html).toContain("Tandai minatmu");
    expect(html).not.toContain("Segera ditutup");
    expect(html).not.toContain("shelf-track");
  });

  it("drops a row — and records the failure — when its read throws", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);
    mockListPublicCompetitions.mockRejectedValue(new Error("db unavailable"));

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Pilih arenamu");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "home.shelf.load-failed",
      expect.objectContaining({ shelf: "pool", error: "db unavailable" }),
    );
  });
});
