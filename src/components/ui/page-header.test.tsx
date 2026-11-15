import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./page-header";

describe("PageHeader back arrow", () => {
  it("names the destination page", () => {
    render(<PageHeader title="Daftarkan diri" backHref="/c/x" backName="Seed Hackathon" />);

    const arrow = screen.getByRole("link", { name: "Kembali ke Seed Hackathon" });
    expect(arrow.getAttribute("href")).toBe("/c/x");
    expect(arrow.getAttribute("data-tooltip")).toBe("Kembali ke Seed Hackathon");
  });

  it("is named Kembali when the destination's title is not known", () => {
    render(<PageHeader title="Log audit" backHref="/institution/x" />);

    expect(screen.getByRole("link", { name: "Kembali" })).toBeTruthy();
  });

  it("has no arrow without a destination", () => {
    render(<PageHeader title="Kotak masuk" />);

    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("PageHeader title mark", () => {
  it("sits with the last word of the title inside the heading", () => {
    const { container } = render(
      <PageHeader title="Kompetisi unggulan baru" titleMark={<span>Draf</span>} />,
    );

    const lastWord = container.querySelector(".page-heading-last-word");
    expect(lastWord?.textContent).toBe("baruDraf");
    expect(lastWord?.querySelector(".page-heading-mark")?.textContent).toBe("Draf");
    expect(screen.getByRole("heading", { level: 1 }).contains(lastWord)).toBe(true);
  });

  it("adds nothing when there is no mark", () => {
    const { container } = render(<PageHeader title="Kompetisi" titleMark={null} />);

    expect(container.querySelector(".page-heading-mark")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Kompetisi");
  });
});

describe("PageHeader action", () => {
  it("puts an icon action on the title line", () => {
    const { container } = render(
      <PageHeader
        title="Kompetisi"
        action={{ kind: "icon", control: <button type="button">Buat kompetisi</button> }}
      />,
    );

    const titleRow = container.querySelector(".page-heading-title-row");
    expect(titleRow?.querySelector(".page-heading-icon-action button")).not.toBeNull();
    expect(container.querySelector(".page-heading-text-action")).toBeNull();
  });

  it("puts a text action on its own line after the description", () => {
    const { container } = render(
      <PageHeader
        title="Verifikasi pembayaran"
        description="Seed Hackathon Nusantara"
        action={{ kind: "text", href: "/peserta", label: "Peserta", icon: "users" }}
      />,
    );

    const header = container.querySelector("header");
    const children = [...(header?.children ?? [])].map((child) => child.className);
    expect(children).toEqual([
      "page-heading-title-row",
      "page-heading-description",
      "page-heading-text-action",
    ]);
    expect(screen.getByRole("link", { name: "Peserta" }).getAttribute("href")).toBe("/peserta");
    expect(container.querySelector(".page-heading-icon-action")).toBeNull();
  });
});
