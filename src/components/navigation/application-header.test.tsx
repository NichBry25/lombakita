import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signOut: vi.fn(),
}));
vi.mock("@/app/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

import { ApplicationHeader } from "./application-header";

describe("ApplicationHeader theme button", () => {
  beforeEach(() => {
    window.localStorage.setItem("lombakita-theme", "light");
  });

  afterEach(() => {
    window.localStorage.removeItem("lombakita-theme");
    delete document.documentElement.dataset.theme;
  });

  it("keeps the theme button's label and shows dark mode as pressed", async () => {
    render(<ApplicationHeader />);
    const toggle = await screen.findByRole("button", { name: "Tema gelap" });
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));

    fireEvent.click(toggle);

    const pressedToggle = screen.getByRole("button", { name: "Tema gelap" });
    expect(pressedToggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

const hrefsOf = (links: HTMLElement[]) => links.map((link) => link.getAttribute("href"));

describe("ApplicationHeader sign-in links", () => {
  afterEach(() => {
    navigation.pathname = "/";
  });

  it("links sign-in and sign-up back to the current page", () => {
    navigation.pathname = "/competitions/acme/lomba-1";

    render(<ApplicationHeader />);

    expect(hrefsOf(screen.getAllByRole("link", { name: "Masuk" }))).toEqual([
      "/auth/login?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
      "/auth/login?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
    ]);
    expect(hrefsOf(screen.getAllByRole("link", { name: /^Daftar/ }))).toEqual([
      "/auth/register?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
      "/auth/register?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
    ]);
  });

  it("keeps sign-in plain on the sign-in pages", () => {
    navigation.pathname = "/auth/login";

    render(<ApplicationHeader />);

    expect(hrefsOf(screen.getAllByRole("link", { name: "Masuk" }))).toEqual([
      "/auth/login",
      "/auth/login",
    ]);
    expect(hrefsOf(screen.getAllByRole("link", { name: /^Daftar/ }))).toEqual([
      "/auth/register",
      "/auth/register",
    ]);
  });

  it("keeps sign-in plain for a path to another site", () => {
    navigation.pathname = "//example.com";

    render(<ApplicationHeader />);

    expect(hrefsOf(screen.getAllByRole("link", { name: "Masuk" }))).toEqual([
      "/auth/login",
      "/auth/login",
    ]);
    expect(hrefsOf(screen.getAllByRole("link", { name: /^Daftar/ }))).toEqual([
      "/auth/register",
      "/auth/register",
    ]);
  });
});
