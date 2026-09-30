// @vitest-environment jsdom
//
// WHAT THE GOOGLE ROLE PICKER FILLS INTO "Nama lengkap".
//
// The onboarding form that follows the role choice prefills the declared full name. The only
// truthful source for it is the `name` claim the identity carrier carried; the account's email is
// not a name, and prefilling it is invisible until an operator reads the profile.
//
// Both directions are asserted because an implementation that prefills nothing at all would satisfy
// the absent-name case on its own.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { OAuthRolePicker } from "./oauth-role-picker";

// The finalize call posts to the oauth-finalize credentials provider; nothing here reaches it.
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

// PageTransitionProvider reads the pathname.
vi.mock("next/navigation", () => ({
  usePathname: () => "/auth/login",
}));

const CARRIER = "carrier.payload.signature";
const EMAIL = "andi.saputra@example.test";

const renderPicker = (name: string | null) =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <OAuthRolePicker carrier={CARRIER} email={EMAIL} name={name} />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const chooseRole = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
};

const nameFieldValue = () =>
  (screen.getByLabelText(/Nama lengkap/) as HTMLInputElement).value;

describe("the name the Google role picker prefills", () => {
  it("carries the identity's name into the candidate form", () => {
    renderPicker("Andi Saputra");

    chooseRole("Daftar sebagai kandidat");

    expect(nameFieldValue()).toBe("Andi Saputra");
  });

  it("carries the identity's name into the recruiter form", () => {
    renderPicker("Andi Saputra");

    chooseRole("Daftar sebagai rekruter");

    expect(nameFieldValue()).toBe("Andi Saputra");
  });

  it("leaves the candidate field empty when the identity carried no name", () => {
    renderPicker(null);

    chooseRole("Daftar sebagai kandidat");

    expect(nameFieldValue()).toBe("");
    expect(nameFieldValue()).not.toBe(EMAIL);
  });

  it("leaves the recruiter field empty when the identity carried an empty name", () => {
    renderPicker("");

    chooseRole("Daftar sebagai rekruter");

    expect(nameFieldValue()).toBe("");
    expect(nameFieldValue()).not.toBe(EMAIL);
  });
});
