// @vitest-environment jsdom
//
// Where a Google sign-up returns, run through the two real screens of the flow: the sign-in entry
// that starts Google and the details form that finishes the sign-up after Google sends the person
// back. The tab is what carries the starting page between them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { signIn } from "next-auth/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { AuthEntry } from "./auth-entry";
import { OAuthRolePicker } from "./oauth-role-picker";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

// PageTransitionProvider reads the pathname.
vi.mock("next/navigation", () => ({
  usePathname: () => "/auth/login",
}));

const RETURN_PATH = "/competitions/acme/lomba-1";
const CARRIER = "carrier.payload.signature";

afterEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

const startGoogleFrom = (callbackUrl?: string) => {
  const view = render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <AuthEntry googleEnabled verificationEnabled callbackUrl={callbackUrl} />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan Google/ }));
  view.unmount();
};

const finishCandidateSignUp = () => {
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <OAuthRolePicker carrier={CARRIER} email="andi.saputra@example.test" name="Andi Saputra" />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );
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

describe("where a Google sign-up returns", () => {
  it("returns a Google sign-up to the page it started from", async () => {
    startGoogleFrom(RETURN_PATH);

    expect(signIn).toHaveBeenCalledWith("google", { callbackUrl: RETURN_PATH });

    finishCandidateSignUp();

    await vi.waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "oauth-finalize",
        expect.objectContaining({ carrier: CARRIER, callbackUrl: RETURN_PATH }),
      ),
    );
  });

  it("returns a Google sign-up started without a return address to the home page", async () => {
    startGoogleFrom(RETURN_PATH);
    startGoogleFrom(undefined);

    finishCandidateSignUp();

    await vi.waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "oauth-finalize",
        expect.objectContaining({ callbackUrl: "/" }),
      ),
    );
  });
});
