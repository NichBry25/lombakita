// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const authService = vi.hoisted(() => {
  const refuse = () =>
    vi.fn(() => {
      throw new Error("the old-link page must not call the auth service");
    });

  return {
    verifyRegistrationEmailToken: refuse(),
    verifyEmailCodeAndSetPassword: refuse(),
    registerUserWithCredentials: refuse(),
    resendRegistrationVerification: refuse(),
    authenticateWithEmailPassword: refuse(),
    classifyEmailForLogin: refuse(),
  };
});

vi.mock("@/server/auth/credentials-auth", () => ({
  ...authService,
  CredentialsAuthError: class extends Error {},
}));

import VerifyEmailPage from "./page";

describe("the page an old verification link opens", () => {
  it("explains that links are no longer used and changes nothing", () => {
    render(VerifyEmailPage());

    expect(screen.getByText("Tautan ini sudah tidak dipakai")).toBeTruthy();
    const signInLink = screen.getByRole("link", { name: /Ke halaman masuk/ });
    expect(signInLink.getAttribute("href")).toBe("/auth/login");
    for (const serviceFunction of Object.values(authService)) {
      expect(serviceFunction).not.toHaveBeenCalled();
    }
  });
});
