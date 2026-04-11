import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("HomePage", () => {
  it("renders Step 1.5 baseline messaging", () => {
    render(<HomePage />);

    expect(screen.getByText(/Lombakita Platform Baseline/i)).toBeTruthy();
    expect(screen.getByText(/Step 1.5 deployment baseline is active/i)).toBeTruthy();
    expect(
      screen.getByText(/No student\/institution\/competition business workflows yet/i),
    ).toBeTruthy();
  });
});
