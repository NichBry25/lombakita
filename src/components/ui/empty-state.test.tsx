import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("draws the icon circle at the standard size and names the title in a paragraph", () => {
    const { container } = render(
      <EmptyState
        kind="nothing-yet"
        title="Belum ada peserta"
        description="Peserta akan muncul."
      />,
    );

    expect(container.querySelector(".empty-state-icon")).not.toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Belum ada peserta").tagName).toBe("P");
  });

  it("has no icon at the compact size", () => {
    const { container } = render(
      <EmptyState
        kind="nothing-yet"
        size="compact"
        title="Belum ada pendaftaran tim"
        description="Tim akan muncul di sini."
      />,
    );

    expect(container.querySelector(".empty-state-icon")).toBeNull();
  });

  it("makes the title the page heading on a page that is only this state", () => {
    render(
      <EmptyState
        kind="not-found"
        titleIsPageHeading
        title="Kompetisi tidak ditemukan"
        description="Data kompetisi tidak dapat dimuat."
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Kompetisi tidak ditemukan" }),
    ).toBeTruthy();
  });

  it("carries no live region of its own", () => {
    const { container } = render(
      <EmptyState kind="no-match" title="Belum ada hasil" description="Coba kata kunci lain." />,
    );

    expect(container.querySelector("[aria-live], [role='status']")).toBeNull();
  });

  describe("action", () => {
    it("is Utama on a standard nothing-yet state", () => {
      render(
        <EmptyState
          kind="nothing-yet"
          title="Belum ada kompetisi tersimpan"
          description="Simpan kompetisi."
          action={{ label: "Jelajahi kompetisi", href: "/competitions" }}
        />,
      );

      const link = screen.getByRole("link", { name: "Jelajahi kompetisi" });
      expect(link.getAttribute("href")).toBe("/competitions");
      expect(link.getAttribute("data-variant")).toBe("primary");
    });

    it("is a Kedua link on a standard no-match state", () => {
      render(
        <EmptyState
          kind="no-match"
          title="Belum ada hasil yang cocok"
          description="Coba kata kunci lain."
          action={{ label: "Bersihkan filter", href: "/competitions" }}
        />,
      );

      expect(
        screen.getByRole("link", { name: "Bersihkan filter" }).getAttribute("data-variant"),
      ).toBe("outline");
    });

    it("is a Tautan aksi at the compact size", () => {
      render(
        <EmptyState
          kind="nothing-yet"
          size="compact"
          title="Belum ada kompetisi"
          description="Draf akan muncul di sini."
          action={{ label: "Buat draf pertama", href: "/new" }}
        />,
      );

      expect(
        screen.getByRole("link", { name: "Buat draf pertama" }).getAttribute("data-variant"),
      ).toBe("link");
    });

    it("calls the handler of a button action", () => {
      const onSelect = vi.fn();
      render(
        <EmptyState
          kind="no-match"
          size="compact"
          title="Belum ada kompetisi yang cocok"
          description="Coba pilih status lain."
          action={{ label: "Tampilkan semua", onSelect }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Tampilkan semua" }));

      expect(onSelect).toHaveBeenCalledTimes(1);
    });
  });
});
