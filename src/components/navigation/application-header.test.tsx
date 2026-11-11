import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
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
