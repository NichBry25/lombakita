import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
const auth = vi.hoisted(() => ({
  session: null as null | { user: { role: string; verifiedRoles: string[] } },
  status: "unauthenticated" as "loading" | "authenticated" | "unauthenticated",
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: auth.session, status: auth.status }),
  signOut: auth.signOut,
}));
vi.mock("@/app/notification-bell", () => ({
  NotificationBell: ({ isCurrentPage }: { isCurrentPage?: boolean }) => (
    <span data-testid="notification-bell" data-current={String(Boolean(isCurrentPage))} />
  ),
}));
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

type MediaChangeListener = (event: { matches: boolean }) => void;

const mediaListeners: MediaChangeListener[] = [];

function signInAs(role: string, verifiedRoles: string[]) {
  auth.session = { user: { role, verifiedRoles } };
  auth.status = "authenticated";
}

// jsdom has no matchMedia. The header reads it for the system theme and the phone sheet listens to
// it for the viewport growing, so the stub records the listeners a test can then fire.
beforeEach(() => {
  mediaListeners.length = 0;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_type: string, listener: MediaChangeListener) => {
      mediaListeners.push(listener);
    },
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  navigation.pathname = "/";
  auth.session = null;
  auth.status = "unauthenticated";
  auth.signOut.mockClear();
  Reflect.deleteProperty(window, "matchMedia");
});

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
    expect(toggle.getAttribute("data-tooltip")).toBe("Aktifkan tema gelap");

    fireEvent.click(toggle);

    const pressedToggle = screen.getByRole("button", { name: "Tema gelap" });
    expect(pressedToggle.getAttribute("aria-pressed")).toBe("true");
    expect(pressedToggle.getAttribute("data-tooltip")).toBe("Matikan tema gelap");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

const hrefsOf = (links: HTMLElement[]) => links.map((link) => link.getAttribute("href"));

describe("ApplicationHeader sign-in link", () => {
  it("offers one Masuk on the bar and one in the phone sheet, back to the current page, and no Daftar", () => {
    navigation.pathname = "/competitions/acme/lomba-1";

    render(<ApplicationHeader />);

    expect(hrefsOf(screen.getAllByRole("link", { name: "Masuk" }))).toEqual([
      "/auth/login?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
      "/auth/login?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
    ]);
    expect(screen.queryAllByRole("link", { name: /^Daftar/ })).toHaveLength(0);
  });

  it.each(["/auth/login", "/auth/register"])("offers no sign-in link on %s", (pathname) => {
    navigation.pathname = pathname;

    render(<ApplicationHeader />);

    expect(screen.queryAllByRole("link", { name: "Masuk" })).toHaveLength(0);
  });

  it("keeps sign-in plain on other auth pages", () => {
    navigation.pathname = "/auth/verify-email";

    render(<ApplicationHeader />);

    expect(hrefsOf(screen.getAllByRole("link", { name: "Masuk" }))).toEqual([
      "/auth/login",
      "/auth/login",
    ]);
  });

  it("keeps sign-in plain for a path to another site", () => {
    navigation.pathname = "//example.com";

    render(<ApplicationHeader />);

    expect(hrefsOf(screen.getAllByRole("link", { name: "Masuk" }))).toEqual([
      "/auth/login",
      "/auth/login",
    ]);
  });

  it("draws no inbox for a signed-out visitor", () => {
    render(<ApplicationHeader />);

    expect(screen.queryByTestId("notification-bell")).toBeNull();
  });
});

describe("ApplicationHeader while the session loads", () => {
  it("reserves the identity slot and draws neither Masuk nor Akun", () => {
    auth.status = "loading";

    const { container } = render(<ApplicationHeader />);

    expect(container.querySelector(".header-identity-reserve")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Masuk" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Akun" })).toBeNull();
    expect(screen.queryByTestId("notification-bell")).toBeNull();
  });
});

describe("ApplicationHeader signed in", () => {
  it("draws the inbox and one Akun control, and no sign-out icon or Masuk", () => {
    signInAs("candidate", ["candidate"]);

    render(<ApplicationHeader />);

    expect(screen.getByTestId("notification-bell")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Akun" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Profil dan akun saya" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Masuk" })).toBeNull();
  });

  it("opens the account menu with Profil and Keluar, and Escape returns focus to the icon", () => {
    signInAs("candidate", ["candidate"]);
    render(<ApplicationHeader />);
    const icon = screen.getByRole("button", { name: "Akun" });
    expect(icon.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(icon);

    expect(icon.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Profil" }).getAttribute("href")).toBe("/profile");
    expect(screen.getByRole("menuitem", { name: "Keluar" })).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("menu", { name: "Akun" }), { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Akun" })).toBeNull();
    expect(document.activeElement).toBe(icon);
  });

  it("signs out at once and goes to the landing page", () => {
    signInAs("candidate", ["candidate"]);
    render(<ApplicationHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Akun" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Keluar" }));

    expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("tells the inbox it is the current page on /inbox only", () => {
    signInAs("candidate", ["candidate"]);
    navigation.pathname = "/inbox";
    const { unmount } = render(<ApplicationHeader />);
    expect(screen.getByTestId("notification-bell").getAttribute("data-current")).toBe("true");
    unmount();

    navigation.pathname = "/saved";
    render(<ApplicationHeader />);
    expect(screen.getByTestId("notification-bell").getAttribute("data-current")).toBe("false");
  });

  it("marks the Akun icon current on the profile page", () => {
    signInAs("candidate", ["candidate"]);
    navigation.pathname = "/profile";

    render(<ApplicationHeader />);

    expect(screen.getByRole("button", { name: "Akun" }).getAttribute("aria-current")).toBe("page");
  });

  it("offers Dasbor to a participant and Platform Operations to platform ops only", () => {
    signInAs("candidate", ["candidate"]);
    const { unmount } = render(<ApplicationHeader />);
    expect(screen.getByRole("button", { name: "Dasbor" })).not.toBeNull();
    expect(screen.queryAllByRole("link", { name: "Platform Operations" })).toHaveLength(0);
    unmount();

    signInAs("platform_ops", []);
    render(<ApplicationHeader />);
    expect(screen.queryByRole("button", { name: "Dasbor" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Platform Operations" }).length).toBeGreaterThan(0);
  });

  it("tells a candidate without an organiser profile to activate Penyelenggara", () => {
    signInAs("candidate", ["candidate"]);
    render(<ApplicationHeader />);

    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));

    const organiserRow = screen.getByRole("menuitem", { name: /^Penyelenggara/ });
    expect(organiserRow.textContent).toContain("Aktifkan");
    expect(organiserRow.getAttribute("href")).toBe("/auth/verify-role?as=recruiter");
    expect(screen.getByRole("menuitem", { name: "Kandidat" }).getAttribute("href")).toBe(
      "/candidate-dashboard",
    );
  });

  it("marks Jelajahi current under /competitions", () => {
    navigation.pathname = "/competitions/acme/lomba-1";

    render(<ApplicationHeader />);

    const links = screen.getAllByRole("link", { name: "Jelajahi" });
    expect(links.every((link) => link.getAttribute("aria-current") === "page")).toBe(true);
  });
});

describe("ApplicationHeader phone sheet", () => {
  function openSheet() {
    const toggle = screen.getByRole("button", { name: "Buka menu" });
    fireEvent.click(toggle);
    return screen.getByRole("button", { name: "Tutup menu" });
  }

  it("opens over the page with the first row focused", () => {
    const { container } = render(<ApplicationHeader />);

    openSheet();

    const sheet = container.querySelector(".header-sheet");
    expect(sheet?.getAttribute("data-open")).toBe("true");
    expect(container.querySelector(".header-sheet-scrim")?.getAttribute("data-open")).toBe("true");
    expect(document.activeElement).toBe(sheet?.querySelector("a"));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes on Escape with focus back on the toggle and the page scrolling again", () => {
    const { container } = render(<ApplicationHeader />);
    const toggle = openSheet();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(container.querySelector(".header-sheet")?.getAttribute("data-open")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on a tap on the scrim", () => {
    const { container } = render(<ApplicationHeader />);
    openSheet();

    fireEvent.click(container.querySelector(".header-sheet-scrim") as Element);

    expect(container.querySelector(".header-sheet")?.getAttribute("data-open")).toBe("false");
  });

  it("closes when the toggle is pressed again", () => {
    const { container } = render(<ApplicationHeader />);
    const closeToggle = openSheet();

    fireEvent.click(closeToggle);

    expect(container.querySelector(".header-sheet")?.getAttribute("data-open")).toBe("false");
    expect(screen.getByRole("button", { name: "Buka menu" })).not.toBeNull();
  });

  it("closes when a row is chosen", () => {
    const { container } = render(<ApplicationHeader />);
    openSheet();

    fireEvent.click(container.querySelector(".header-sheet a") as Element);

    expect(container.querySelector(".header-sheet")?.getAttribute("data-open")).toBe("false");
  });

  it("closes when the route changes from elsewhere", () => {
    const { container, rerender } = render(<ApplicationHeader />);
    openSheet();

    navigation.pathname = "/competitions";
    rerender(<ApplicationHeader />);

    expect(container.querySelector(".header-sheet")?.getAttribute("data-open")).toBe("false");
  });

  it("closes when the viewport grows past the phone width", () => {
    const { container } = render(<ApplicationHeader />);
    openSheet();

    act(() => {
      mediaListeners.forEach((listener) => listener({ matches: true }));
    });

    expect(container.querySelector(".header-sheet")?.getAttribute("data-open")).toBe("false");
  });

  it("shows signed-out visitors Jelajahi and a Masuk button", () => {
    const { container } = render(<ApplicationHeader />);

    const rows = container.querySelectorAll(".header-sheet a");

    expect([...rows].map((row) => row.textContent)).toEqual(["Jelajahi", "Masuk"]);
  });

  it("groups a signed-in candidate's rows as where to go, the dashboards and the account", () => {
    signInAs("candidate", ["candidate", "recruiter"]);
    const { container } = render(<ApplicationHeader />);

    const groups = [...container.querySelectorAll(".header-sheet-group")].map((group) =>
      [...group.querySelectorAll("a, button")].map((row) => row.textContent),
    );

    expect(groups).toEqual([
      ["Jelajahi"],
      ["Dasbor kandidat", "Dasbor penyelenggara"],
      ["Profil", "Keluar"],
    ]);
  });
});
