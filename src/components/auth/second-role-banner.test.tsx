// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SecondRoleBanner } from "./second-role-banner";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("the second role banner", () => {
  it("offers a participant the host step as Mulai menyelenggarakan", () => {
    render(<SecondRoleBanner unverifiedRole="recruiter" userId="user-42" />);

    expect(screen.getByText("Ingin menyelenggarakan kompetisi?")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Mulai menyelenggarakan" });
    expect(link.getAttribute("href")).toBe("/auth/verify-role?as=recruiter");
  });

  it("keeps the participant offer to a host", () => {
    render(<SecondRoleBanner unverifiedRole="candidate" userId="user-42" />);

    const link = screen.getByRole("link", { name: "Verifikasi kandidat" });
    expect(link.getAttribute("href")).toBe("/auth/verify-role?as=candidate");
  });
});
