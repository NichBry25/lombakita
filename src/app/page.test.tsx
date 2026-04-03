import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("HomePage", () => {
  it("renders scaffold heading", () => {
    render(<HomePage />);

    expect(screen.getByText(/Lombakita Platform Baseline/i)).toBeTruthy();
    expect(screen.getByText(/No business domain features implemented yet/i)).toBeTruthy();
  });
});
