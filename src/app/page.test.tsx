import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("HomePage", () => {
  it("renders the Lombakita home page", () => {
    render(<HomePage />);

    expect(screen.getByText(/Lombakita/i)).toBeTruthy();
    expect(screen.getByText(/Platform peluang mahasiswa Indonesia/i)).toBeTruthy();
    expect(screen.getByText(/Login atau daftar akun/i)).toBeTruthy();
  });
});
