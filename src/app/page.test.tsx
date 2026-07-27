// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockListFeaturedCompetitions, mockLoggerError } = vi.hoisted(() => ({
  mockListFeaturedCompetitions: vi.fn(),
  mockLoggerError: vi.fn(),
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
vi.mock("@/server/competitions/competition-public-service", () => ({
  listFeaturedCompetitions: mockListFeaturedCompetitions,
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import HomePage from "@/app/page";

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

describe("HomePage", () => {
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
});
