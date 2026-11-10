// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { InstitutionCompetitionsShell } from "./institution-competitions-shell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/institution/institusi-contoh/competitions",
}));

const DAY = 24 * 60 * 60 * 1000;

const competition = (slug: string, status: "draft" | "published") => ({
  id: `id_${slug}`,
  slug,
  title: `Judul ${slug}`,
  status,
  eventEndAt: new Date(Date.now() + 30 * DAY).toISOString(),
  createdAt: new Date(Date.now() - DAY).toISOString(),
});

const mountWith = (competitions: unknown[]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ competitions }) } as Response),
  );
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <InstitutionCompetitionsShell institutionSlug="institusi-contoh" />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );
};

describe("InstitutionCompetitionsShell row action", () => {
  it("offers a draft's editor as Lanjutkan", async () => {
    mountWith([competition("lomba-draf", "draft")]);

    const action = await screen.findByRole("link", { name: "Lanjutkan" });
    expect(action.getAttribute("href")).toBe(
      "/institution/institusi-contoh/competitions/lomba-draf/edit",
    );
    expect(screen.queryByRole("link", { name: "Peserta" })).toBeNull();
  });

  it("keeps Peserta on a published row", async () => {
    mountWith([competition("lomba-terbit", "published")]);

    const action = await screen.findByRole("link", { name: "Peserta" });
    expect(action.getAttribute("href")).toBe(
      "/institution/institusi-contoh/competitions/lomba-terbit/participants",
    );
    expect(screen.queryByRole("link", { name: "Lanjutkan" })).toBeNull();
  });
});
