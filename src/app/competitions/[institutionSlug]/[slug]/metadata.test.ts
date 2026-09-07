// @vitest-environment node
//
// A shared competition link has to look like that competition.
//
// Before this page declared any metadata it inherited the root layout's, so every competition ever
// pasted into WhatsApp — the channel this audience shares in, and one that reads Open Graph rather
// than the page — previewed as the site name and the site's own description. Every competition
// looked identical, to a person and to a crawler.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getPublicCompetitionDetail = vi.fn();

vi.mock("@/server/competitions/competition-public-service", () => ({
  getPublicCompetitionDetail: (institutionSlug: string, slug: string) =>
    getPublicCompetitionDetail(institutionSlug, slug),
  listPublicCompetitions: vi.fn(),
}));

import { generateMetadata } from "./page";

const params = (institutionSlug: string, slug: string) =>
  Promise.resolve({ institutionSlug, slug });

const competition = (overrides: Record<string, unknown> = {}) => ({
  title: "Hackathon Nusantara",
  description: "Kompetisi membangun produk digital selama 48 jam.",
  organizer: { name: "Seed Academy", logoUrl: "https://cdn.example.test/logo.png" },
  ...overrides,
});

beforeEach(() => {
  getPublicCompetitionDetail.mockReset();
  getPublicCompetitionDetail.mockResolvedValue(competition());
});

describe("competition detail metadata", () => {
  it("titles the page after the competition and its organizer", async () => {
    const metadata = await generateMetadata({ params: params("seed-academy", "seed-open") });

    expect(metadata.title).toBe("Hackathon Nusantara · Seed Academy · Lombakita");
  });

  it("describes the competition rather than the site", async () => {
    const metadata = await generateMetadata({ params: params("seed-academy", "seed-open") });

    expect(metadata.description).toBe("Kompetisi membangun produk digital selama 48 jam.");
  });

  it("carries Open Graph tags naming this competition, which is what a link preview reads", async () => {
    const { openGraph } = await generateMetadata({ params: params("seed-academy", "seed-open") });

    expect(openGraph?.title).toBe("Hackathon Nusantara · Seed Academy · Lombakita");
    expect(openGraph?.description).toBe("Kompetisi membangun produk digital selama 48 jam.");
    expect(openGraph?.url).toBe("/competitions/seed-academy/seed-open");
    expect((openGraph as { images?: Array<{ url: string }> })?.images).toEqual([
      { url: "https://cdn.example.test/logo.png" },
    ]);
  });

  it("invites indexing only for a competition that resolved", async () => {
    const metadata = await generateMetadata({ params: params("seed-academy", "seed-open") });

    expect(metadata.robots).toMatchObject({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("/competitions/seed-academy/seed-open");
  });

  it("withholds a competition that is unpublished, archived or withheld", async () => {
    // The page answers 404 for exactly these, so `getPublicCompetitionDetail` returning null is
    // how an unpublished competition reaches this function. It must not opt into indexing, and it
    // then inherits the root layout's `noindex`.
    getPublicCompetitionDetail.mockResolvedValue(null);

    const metadata = await generateMetadata({ params: params("seed-academy", "draft-only") });

    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe("Kompetisi tidak ditemukan · Lombakita");
    expect(metadata.openGraph).toBeUndefined();
  });

  it("truncates an organizer's long prose instead of handing a scraper a wall of text", async () => {
    getPublicCompetitionDetail.mockResolvedValue(competition({ description: "a".repeat(400) }));

    const { description } = await generateMetadata({ params: params("seed-academy", "long") });

    expect(description?.length).toBeLessThanOrEqual(201);
    expect(description?.endsWith("…")).toBe(true);
  });

  it("collapses the whitespace an organizer's line breaks leave in a preview", async () => {
    getPublicCompetitionDetail.mockResolvedValue(
      competition({ description: "Baris satu.\n\n   Baris dua." }),
    );

    const { description } = await generateMetadata({ params: params("seed-academy", "wrapped") });

    expect(description).toBe("Baris satu. Baris dua.");
  });

  it("falls back to a stated sentence when an organizer left the description empty", async () => {
    getPublicCompetitionDetail.mockResolvedValue(competition({ description: "   " }));

    const { description } = await generateMetadata({ params: params("seed-academy", "bare") });

    expect(description).toBe("Hackathon Nusantara, diselenggarakan Seed Academy di Lombakita.");
  });

  it("asks for a text-only card when the organizer has no logo, not someone else's picture", async () => {
    getPublicCompetitionDetail.mockResolvedValue(
      competition({ organizer: { name: "Seed Academy", logoUrl: null } }),
    );

    const metadata = await generateMetadata({ params: params("seed-academy", "no-logo") });

    expect((metadata.openGraph as { images?: unknown })?.images).toBeUndefined();
    expect((metadata.twitter as { card?: string })?.card).toBe("summary");
  });

  it("reads the competition named by the URL", async () => {
    await generateMetadata({ params: params("other-academy", "other-slug") });

    expect(getPublicCompetitionDetail).toHaveBeenCalledWith("other-academy", "other-slug");
  });
});
