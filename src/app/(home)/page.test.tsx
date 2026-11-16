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
// The home search form reads the router, which does not exist outside a mounted app.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/server/competitions/competition-public-service", () => ({
  listFeaturedCompetitions: mockListFeaturedCompetitions,
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import HomePage from "@/app/(home)/page";

const countOccurrences = (html: string, fragment: string) => html.split(fragment).length - 1;

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
  resultAnnouncementAt: null,
  cancelledAt: null,
  hasPublishedResult: false,
  publishedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  isFeatured: true,
  institutionSlug: "ui",
  institutionName: "Universitas Indonesia",
  institutionLogoUrl: null as string | null,
});

describe("HomePage", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the hero and discovery sections with featured competitions present", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1), featuredItem(2)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(mockListFeaturedCompetitions).toHaveBeenCalledWith(4);
    expect(html).toContain("Cari kompetisi, cek tenggat");
    expect(html).toContain("Mulai mencari");
  });

  it("renders the home search bar as a form to the competition list with a field named q", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    const form = html.match(/<form\b[^>]*home-search-entry[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('action="/competitions"');
    expect(form).toContain('name="q"');
    expect(form).toContain('placeholder="Cari judul atau kata kunci…"');
    expect(html).not.toContain("Nama, kategori, atau penyelenggara");
  });

  it("renders the featured carousel section when featured competitions exist", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Kompetisi Unggulan 1");
    expect(html).toContain("Kompetisi unggulan");
  });

  it("renders cleanly with no broken carousel when there are no featured competitions", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).not.toContain("Kompetisi unggulan");
    expect(html).not.toContain("featured-carousel");
    // Rest of the page still renders.
    expect(html).toContain("Buka ruang kerja");
  });

  it("does not bring back the category section", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).not.toContain("Kategori kompetisi");
    expect(html).not.toContain("home-category");
    expect(html).not.toContain("/competitions?category=");
  });

  it("shows one art field, and marks the box the field keeps clear", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    expect(countOccurrences(html, 'class="home-memphis"')).toBe(1);
    expect(countOccurrences(html, "data-hero-clearing")).toBe(1);
  });

  it("does not bring back the hero sentence or the three check marks", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).not.toContain("Lihat tenggat, hadiah, dan penyelenggara");
    expect(html).not.toContain("Tanda penyelenggara terverifikasi");
    expect(html).not.toContain("Tenggat di setiap kartu");
    expect(html).not.toContain("Daftar tanpa pindah situs");
    expect(html).not.toContain("home-trust-row");
  });

  it("shows a featured card with no description and no arrow, and names the all-competitions link in full", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Kompetisi Unggulan 1");
    expect(html).not.toContain("Deskripsi kompetisi.");
    expect(html).not.toContain("competition-description");
    expect(html).not.toContain("competition-card-arrow");
    expect(html).toContain('aria-label="Lihat semua kompetisi"');
  });

  it("does not show the editor's pick pill on a featured card", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([featuredItem(1), featuredItem(2)]);

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Kompetisi Unggulan 1");
    expect(html).not.toContain("Pilihan Editor");
    expect(html).not.toContain('data-status="featured"');
  });

  it("shows the organiser's logo in a featured card's badge, and the trophy on a card without one", async () => {
    const withLogo = { ...featuredItem(1), institutionLogoUrl: "https://files.test/ui.png" };
    mockListFeaturedCompetitions.mockResolvedValue([withLogo, featuredItem(2)]);

    const html = renderToStaticMarkup(await HomePage());

    const badges = [
      ...html.matchAll(/<span class="competition-cover-icon"[^>]*>([\s\S]*?)<\/span>/g),
    ].map((match) => match[1]);
    expect(badges).toHaveLength(2);
    expect(badges[0]).toContain('<img src="https://files.test/ui.png" alt=""');
    expect(badges[0]).not.toContain("<svg");
    expect(badges[1]).toContain("<svg");
    expect(badges[1]).not.toContain("<img");
  });

  it("sends the hosting button to the host dashboard", async () => {
    mockListFeaturedCompetitions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await HomePage());

    const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
    const hostingLink = anchors.find((anchor) => anchor.includes("Buka ruang kerja"));
    expect(hostingLink).toContain('href="/recruiter-dashboard"');
  });

  it("degrades to no featured rail — and records the failure — when the fetch throws", async () => {
    mockListFeaturedCompetitions.mockRejectedValue(new Error("db unavailable"));

    // The decorative featured rail failing must not take down the whole public homepage.
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Cari kompetisi, cek tenggat");
    expect(html).toContain("Buka ruang kerja");
    expect(html).not.toContain("Kompetisi unggulan");

    // Degraded, but not silently — the failure is logged for observability.
    expect(mockLoggerError).toHaveBeenCalledWith(
      "home.featured-competitions.load-failed",
      expect.objectContaining({ error: "db unavailable" }),
    );
  });
});
