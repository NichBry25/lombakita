// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CompetitionSearchForm } from "./competition-search-form";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the listing search form", () => {
  it("keeps its own button word and field id", () => {
    render(<CompetitionSearchForm params={{}} />);

    expect(screen.getByRole("button", { name: "Cari" })).toBeTruthy();
    expect(document.getElementById("competition-search")).not.toBeNull();
  });
});

describe("the home search form", () => {
  it("is a search form to the competition list with a field named q", () => {
    render(<CompetitionSearchForm params={{}} variant="home" />);

    const form = screen.getByRole("search");
    expect(form.getAttribute("action")).toBe("/competitions");
    const field = document.getElementById("home-search") as HTMLInputElement;
    expect(field.name).toBe("q");
    expect(screen.getByLabelText("Cari kompetisi")).toBe(field);
    expect(screen.getByRole("button", { name: "Mulai mencari" })).toBeTruthy();
  });

  it("opens the list with the typed term", () => {
    render(<CompetitionSearchForm params={{}} variant="home" />);

    const field = document.getElementById("home-search") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "hack" } });
    fireEvent.submit(screen.getByRole("search"));

    expect(mockPush).toHaveBeenCalledWith("/competitions?q=hack");
  });

  it("opens the plain list when the field is empty", () => {
    render(<CompetitionSearchForm params={{}} variant="home" />);

    fireEvent.submit(screen.getByRole("search"));

    expect(mockPush).toHaveBeenCalledWith("/competitions");
  });
});
