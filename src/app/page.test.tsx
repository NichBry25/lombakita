import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("HomePage", () => {
  it("renders Step 2.2 baseline messaging", () => {
    render(<HomePage />);

    expect(screen.getByText(/Lombakita Platform Baseline/i)).toBeTruthy();
    expect(
      screen.getByText(/Step 2.2 institution workspace creation baseline is active/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Institution tenant creation endpoint with owner membership assignment/i),
    ).toBeTruthy();
  });
});
