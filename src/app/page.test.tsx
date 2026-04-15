import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("HomePage", () => {
  it("renders Step 2.1 baseline messaging", () => {
    render(<HomePage />);

    expect(screen.getByText(/Lombakita Platform Baseline/i)).toBeTruthy();
    expect(screen.getByText(/Step 2.1 student profile shell is active/i)).toBeTruthy();
    expect(
      screen.getByText(/Student profile shell endpoint and guarded profile page/i),
    ).toBeTruthy();
  });
});
