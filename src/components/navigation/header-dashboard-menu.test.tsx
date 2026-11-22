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

const BOTH_PROFILES = { candidate: true, recruiter: true };

describe("HeaderDashboardMenu profiles", () => {
  it("keeps the organiser row for a candidate and marks it Aktifkan, going to the role sign-up form", () => {
    render(<HeaderDashboardMenu pathname="/" profiles={{ candidate: true, recruiter: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));

    const organiserRow = screen.getByRole("menuitem", { name: /^Penyelenggara/ });

    expect(organiserRow.textContent).toBe("PenyelenggaraAktifkan");
    expect(organiserRow.getAttribute("href")).toBe("/auth/verify-role?as=recruiter");
    expect(screen.getByRole("menuitem", { name: "Kandidat" }).textContent).toBe("Kandidat");
  });

  it("marks the candidate row Aktifkan for an organiser without a candidate profile", () => {
    render(<HeaderDashboardMenu pathname="/" profiles={{ candidate: false, recruiter: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));

    const candidateRow = screen.getByRole("menuitem", { name: /^Kandidat/ });

    expect(candidateRow.textContent).toBe("KandidatAktifkan");
    expect(candidateRow.getAttribute("href")).toBe("/auth/verify-role?as=candidate");
  });

  it("never marks a row without a profile as the current page", () => {
    render(
      <HeaderDashboardMenu
        pathname="/recruiter-dashboard"
        profiles={{ candidate: true, recruiter: false }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));

    expect(
      screen.getByRole("menuitem", { name: /^Penyelenggara/ }).getAttribute("aria-current"),
    ).toBeNull();
  });
});

describe("HeaderDashboardMenu", () => {
  it("opens the menu with Kandidat and Penyelenggara links on click", () => {
    render(<HeaderDashboardMenu pathname="/" profiles={BOTH_PROFILES} />);
    const trigger = screen.getByRole("button", { name: "Dasbor" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const kandidat = screen.getByRole("menuitem", { name: "Kandidat" });
    const rekruter = screen.getByRole("menuitem", { name: "Penyelenggara" });
    expect(kandidat.getAttribute("href")).toBe("/candidate-dashboard");
    expect(rekruter.getAttribute("href")).toBe("/recruiter-dashboard");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<HeaderDashboardMenu pathname="/" profiles={BOTH_PROFILES} />);
    const trigger = screen.getByRole("button", { name: "Dasbor" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the menu when a menu item is clicked", () => {
    render(<HeaderDashboardMenu pathname="/" profiles={BOTH_PROFILES} />);
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Penyelenggara" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves roving focus between items with arrow keys", () => {
    render(<HeaderDashboardMenu pathname="/" profiles={BOTH_PROFILES} />);
    fireEvent.click(screen.getByRole("button", { name: "Dasbor" }));
    const menu = screen.getByRole("menu");
    const kandidat = screen.getByRole("menuitem", { name: "Kandidat" });
    const rekruter = screen.getByRole("menuitem", { name: "Penyelenggara" });
    expect(document.activeElement).toBe(kandidat);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rekruter);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(kandidat);
  });

  it("marks the trigger and the matching item current on the recruiter dashboard route", () => {
    render(<HeaderDashboardMenu pathname="/recruiter-dashboard" profiles={BOTH_PROFILES} />);
    const trigger = screen.getByRole("button", { name: "Dasbor" });
    expect(trigger.getAttribute("aria-current")).toBe("page");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("menuitem", { name: "Penyelenggara" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("menuitem", { name: "Kandidat" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  it("does not mark the trigger current on unrelated routes", () => {
    render(<HeaderDashboardMenu pathname="/competitions" profiles={BOTH_PROFILES} />);
    expect(screen.getByRole("button", { name: "Dasbor" }).getAttribute("aria-current")).toBeNull();
  });
});
