// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminHostChecksPage from "./page";

const mocks = vi.hoisted(() => ({ guard: vi.fn() }));

vi.mock("@/server/auth/page-guard", () => ({ requireRolePage: mocks.guard }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/admin/host-checks",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/admin/host-check-queue", () => ({
  HostCheckQueue: () => <p>HostCheckQueue stub</p>,
}));
vi.mock("@/components/admin/host-trust-watch-list", () => ({ HostTrustWatchList: () => null }));
vi.mock("@/components/admin/tick-queue", () => ({ TickQueue: () => <p>TickQueue stub</p> }));

type SearchParams = { tab?: string | string[] };

const renderPage = async (searchParams: SearchParams) => {
  const page = await AdminHostChecksPage({ searchParams: Promise.resolve(searchParams) });
  return render(page);
};

const isSelected = (name: string): string | null =>
  screen.getByRole("tab", { name }).getAttribute("aria-selected");

beforeEach(() => {
  mocks.guard.mockReset();
  mocks.guard.mockResolvedValue(undefined);
});

describe("the staff queue page", () => {
  it("opens the Centang tab from ?tab=centang", async () => {
    await renderPage({ tab: "centang" });

    expect(mocks.guard).toHaveBeenCalledExactlyOnceWith("platform_ops", {
      callbackPath: "/admin/host-checks",
    });
    expect(screen.getByRole("heading", { level: 1, name: "Antrean pemeriksaan" })).toBeTruthy();
    expect(isSelected("Centang")).toBe("true");
    expect(isSelected("Pemeriksaan penyelenggara")).toBe("false");
    expect(isSelected("Laporan")).toBe("false");
    expect(screen.getByText("TickQueue stub")).toBeTruthy();
    expect(screen.queryByText("HostCheckQueue stub")).toBeNull();
  });

  it("opens Pemeriksaan penyelenggara with no tab, another word or a repeated tab", async () => {
    const cases: SearchParams[] = [{}, { tab: "lain" }, { tab: ["centang", "laporan"] }];

    for (const searchParams of cases) {
      const { unmount } = await renderPage(searchParams);

      expect(isSelected("Pemeriksaan penyelenggara")).toBe("true");
      expect(screen.getByText("HostCheckQueue stub")).toBeTruthy();
      unmount();
    }
  });

  it("shows the Laporan empty state", async () => {
    await renderPage({ tab: "laporan" });

    expect(screen.getByText("Belum ada laporan")).toBeTruthy();
    expect(screen.getByText("Belum ada laporan kompetisi.")).toBeTruthy();
    expect(screen.queryByText("HostCheckQueue stub")).toBeNull();
    expect(screen.queryByText("TickQueue stub")).toBeNull();
  });
});
