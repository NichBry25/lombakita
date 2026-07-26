import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({
      children,
      href,
      onClick,
      onFocus,
      ...rest
    }: {
      children: unknown;
      href: string;
      onClick?: () => void;
      onFocus?: () => void;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "a",
        {
          href,
          onFocus,
          // jsdom attempts (and fails) to follow real anchor navigation on click; this
          // component only needs the click to close the menu, not to actually navigate.
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            onClick?.();
          },
          ...rest,
        },
        children,
      ),
  };
});

import { HeaderDashboardMenu } from "./header-dashboard-menu";

describe("HeaderDashboardMenu", () => {
  it("opens the menu with Kandidat and Rekruter links on click", () => {
    render(<HeaderDashboardMenu pathname="/" />);
    const trigger = screen.getByRole("button", { name: "Dasbor" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const kandidat = screen.getByRole("menuitem", { name: "Kandidat" });
    const rekruter = screen.getByRole("menuitem", { name: "Rekruter" });
    expect(kandidat.getAttribute("href")).toBe("/candidate-dashboard");
    expect(rekruter.getAttribute("href")).toBe("/recruiter-dashboard");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<HeaderDashboardMenu pathname="/" />);
    const trigger = screen.getByRole("button", { name: "Dasbor" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the menu when a menu item is clicked", () => {
    render(<HeaderDashboardMenu pathname="/" />);
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rekruter" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves roving focus between items with arrow keys", () => {
    render(<HeaderDashboardMenu pathname="/" />);
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));
    const menu = screen.getByRole("menu");
    const kandidat = screen.getByRole("menuitem", { name: "Kandidat" });
    const rekruter = screen.getByRole("menuitem", { name: "Rekruter" });
    expect(document.activeElement).toBe(kandidat);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rekruter);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(kandidat);
  });

  it("marks the trigger and the matching item current on the recruiter dashboard route", () => {
    render(<HeaderDashboardMenu pathname="/recruiter-dashboard" />);
    const trigger = screen.getByRole("button", { name: "Dasbor" });
    expect(trigger.getAttribute("aria-current")).toBe("page");

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Rekruter" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("menuitem", { name: "Kandidat" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  it("does not mark the trigger current on unrelated routes", () => {
    render(<HeaderDashboardMenu pathname="/competitions" />);
    expect(screen.getByRole("button", { name: "Dasbor" }).getAttribute("aria-current")).toBeNull();
  });
});
