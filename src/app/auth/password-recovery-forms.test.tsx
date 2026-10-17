// @vitest-environment jsdom
//
// THE TWO UNAUTHENTICATED PASSWORD FORMS: WHAT THEY SAY FOR AN ANSWER THEY DO NOT NAME.
//
// An unhandled answer shows one generic Indonesian line and never the server's own text, which is
// English and written for a log. The connection line is for a request that itself failed. The
// handled answers keep their own lines.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { ForgotPasswordForm } from "./forgot-password/forgot-password-form";
import { ResetPasswordForm } from "./reset-password/reset-password-form";

vi.mock("next/navigation", () => ({ usePathname: () => "/auth/forgot-password" }));

const fetchMock = vi.fn();

const GENERIC = "Terjadi kesalahan. Coba lagi beberapa saat.";
const CONNECTION = "Terjadi gangguan koneksi. Coba lagi beberapa saat.";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const inProviders = (children: React.ReactNode) =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>{children}</PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the forgot-password form", () => {
  const submitEmail = () => {
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim tautan atur ulang" }));
  };

  it("says the generic line for an answer it does not name", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { message: "raw server text" } }));
    inProviders(<ForgotPasswordForm initialEmail="" />);

    submitEmail();

    expect(await screen.findByText(GENERIC)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("keeps its own lines for 429 and 400", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { code: "rate_limited" } }));
    inProviders(<ForgotPasswordForm initialEmail="" />);
    submitEmail();
    expect(
      await screen.findByText("Terlalu banyak percobaan. Coba lagi beberapa saat."),
    ).toBeTruthy();

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { code: "invalid_payload" } }));
    fireEvent.click(screen.getByRole("button", { name: "Kirim tautan atur ulang" }));
    expect(
      await screen.findByText(
        "Format email tidak valid. Gunakan format seperti nama@kampus.ac.id.",
      ),
    ).toBeTruthy();
  });

  it("keeps the resend button disabled for 60 seconds after a send, and not a second longer", async () => {
    // shouldAdvanceTime lets testing-library's own zero-delay waits resolve under a faked setTimeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-17T10:00:00.000Z"));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { requested: true }));
    inProviders(<ForgotPasswordForm initialEmail="" />);

    submitEmail();
    expect(await screen.findByText("Cek email Anda")).toBeTruthy();
    // The countdown tick is registered by an effect that may still be pending when the state appears.
    await act(async () => {});
    const resendButton = () =>
      screen.getByRole("button", { name: /^Kirim ulang/ }) as HTMLButtonElement;
    expect(resendButton().textContent).toBe("Kirim ulang dalam 60 detik");

    for (let second = 0; second < 59; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toBe("Kirim ulang dalam 1 detik");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(resendButton().disabled).toBe(false);
    expect(resendButton().textContent).toBe("Kirim ulang");
  });

  it("says the connection line only when the request itself fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    inProviders(<ForgotPasswordForm initialEmail="" />);

    submitEmail();

    expect(await screen.findByText(CONNECTION)).toBeTruthy();
  });
});

describe("the reset-password form", () => {
  const submitPassword = () => {
    fireEvent.change(screen.getByLabelText("Password baru"), {
      target: { value: "new-password-2" },
    });
    fireEvent.change(screen.getByLabelText("Ulangi password baru"), {
      target: { value: "new-password-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan password baru" }));
  };

  it("says the generic line for an answer it does not name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "invalid_payload", message: "raw server text" } }),
    );
    inProviders(<ResetPasswordForm token={"a".repeat(64)} />);

    submitPassword();

    expect(await screen.findByText(GENERIC)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("sends the browser to the sign-in page with the changed flag after a reset", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { reset: true }));
    inProviders(<ResetPasswordForm token={"a".repeat(64)} />);

    submitPassword();

    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign).toHaveBeenCalledWith("/auth/login?passwordChanged=1");
  });

  it("names invalid_password in Indonesian", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "invalid_password", message: "raw server text" } }),
    );
    inProviders(<ResetPasswordForm token={"a".repeat(64)} />);

    submitPassword();

    expect(await screen.findByText("Password harus 8 sampai 72 karakter.")).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it.each(["password_reset_token_invalid", "password_reset_token_expired"])(
    "shows the dead-link state for %s",
    async (code) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { code } }));
      inProviders(<ResetPasswordForm token={"a".repeat(64)} />);

      submitPassword();

      expect(
        await screen.findByText("Tautan atur ulang tidak valid atau sudah kedaluwarsa"),
      ).toBeTruthy();
    },
  );

  it("says the connection line only when the request itself fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    inProviders(<ResetPasswordForm token={"a".repeat(64)} />);

    submitPassword();

    expect(await screen.findByText(CONNECTION)).toBeTruthy();
  });
});
