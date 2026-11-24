// @vitest-environment jsdom
//
// WHAT THE GOOGLE DETAILS FORM FILLS INTO "Nama lengkap".
//
// The details form prefills the declared full name. The only
// truthful source for it is the `name` claim the identity carrier carried; the account's email is
// not a name, and prefilling it is invisible until an operator reads the profile.
//
// Both directions are asserted because an implementation that prefills nothing at all would satisfy
// the absent-name case on its own.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { signIn } from "next-auth/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { GOOGLE_RETURN_PATH_KEY } from "./google-return-path";
import { OAuthRolePicker } from "./oauth-role-picker";

// signIn is a mock, so a finalize call made here sends no request. Tests read its arguments.
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

const nameField = () => screen.getByLabelText(/Nama lengkap/) as HTMLInputElement;

const nameFieldValue = () => nameField().value;

describe("the name the Google details form prefills", () => {
  it("carries the identity's name into the details form", () => {
    renderPicker("Andi Saputra");

    expect(nameFieldValue()).toBe("Andi Saputra");
  });

  it("leaves the field empty when the identity carried no name", () => {
    renderPicker(null);

    expect(nameFieldValue()).toBe("");
    expect(nameFieldValue()).not.toBe(EMAIL);
  });

  it("leaves the field empty when the identity carried an empty name", () => {
    renderPicker("");

    expect(nameFieldValue()).toBe("");
    expect(nameFieldValue()).not.toBe(EMAIL);
  });
});

describe("the autofill token on the Google details form's name field", () => {
  it("carries autoComplete=name on the name field", () => {
    renderPicker("Andi Saputra");

    expect(nameField().getAttribute("autocomplete")).toBe("name");
  });

  it("does not carry autoComplete=off on the name field", () => {
    renderPicker("Andi Saputra");

    expect(nameField().getAttribute("autocomplete")).not.toBe("off");
  });
});

describe("what a Google sign-up sends and where it returns", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  const finishCandidateSignUp = () => {
    renderPicker("Andi Saputra");
    fireEvent.change(screen.getByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: "081234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Status saat ini (wajib)" }));
    fireEvent.click(screen.getByRole("option", { name: "Mahasiswa" }));
    fireEvent.change(screen.getByLabelText(/^Tanggal lahir(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: "2000-01-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Selesai" }));
  };

  const finalizeCallbackUrl = async () => {
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    const options = vi.mocked(signIn).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    return options?.callbackUrl;
  };

  it("returns home when the stored return address leads to another site", async () => {
    window.sessionStorage.setItem(GOOGLE_RETURN_PATH_KEY, "//example.com");

    finishCandidateSignUp();

    expect(await finalizeCallbackUrl()).toBe("/");
  });

  it("returns home when the stored return address is longer than 512 characters", async () => {
    window.sessionStorage.setItem(GOOGLE_RETURN_PATH_KEY, "/" + "a".repeat(512));

    finishCandidateSignUp();

    expect(await finalizeCallbackUrl()).toBe("/");
  });

  it("returns home when no return address is stored", async () => {
    finishCandidateSignUp();

    expect(await finalizeCallbackUrl()).toBe("/");
  });

  it("says to sign up by email and code when Google has not verified the address", async () => {
    vi.mocked(signIn).mockResolvedValueOnce({
      ok: false,
      error: "email_unverified",
      status: 401,
      url: null,
    });

    finishCandidateSignUp();

    expect(
      await screen.findByText(
        "Google belum memverifikasi email ini, sehingga akun tidak dapat dibuat dengan Google. Daftar dengan email dan password, lalu masukkan kode verifikasi yang kami kirim ke email Anda.",
      ),
    ).toBeTruthy();
  });

  it("sends the participant details and no role", async () => {
    finishCandidateSignUp();

    await vi.waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    expect(vi.mocked(signIn).mock.calls[0]).toEqual([
      "oauth-finalize",
      {
        carrier: CARRIER,
        fullName: "Andi Saputra",
        phoneNumber: "081234567890",
        occupation: "college_student",
        dateOfBirth: "2000-01-31",
        callbackUrl: "/",
        redirect: false,
      },
    ]);
  });

  it("offers no role choice", () => {
    renderPicker("Andi Saputra");

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/)).toBeTruthy();
  });
});
