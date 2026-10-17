// @vitest-environment jsdom
//
// WHAT THE CHANGE-PASSWORD FORM DOES WITH EACH ANSWER.
//
// Three things are pinned. The expected user id comes in as a PROP and rides the request header, so
// the form is bound to the account its page was rendered for (Rule 16). A 429 shows the lockout
// panel, and whether the submit stays disabled depends on whether the server reported a wait.
// Every answer the form does not name shows one generic Indonesian line, never the server's text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { signOut } from "next-auth/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { ChangePasswordForm } from "./change-password-form";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/auth/change-password" }));

const fetchMock = vi.fn();

const LOCKOUT_WITH_WAIT = "Terlalu banyak password saat ini yang salah. Coba lagi dalam 2 menit.";
const LOCKOUT_WITHOUT_WAIT = "Terlalu banyak password saat ini yang salah. Coba lagi nanti.";
const GENERIC = "Terjadi kesalahan. Coba lagi beberapa saat.";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const renderForm = () =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <ChangePasswordForm expectedUserId="user-42" />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const submitButton = () => screen.getByRole("button", { name: "Ubah password" });

const fillAndSubmit = () => {
  fireEvent.change(screen.getByLabelText("Password saat ini"), {
    target: { value: "old-password-1" },
  });
  fireEvent.change(screen.getByLabelText("Password baru"), {
    target: { value: "new-password-2" },
  });
  fireEvent.change(screen.getByLabelText("Ulangi password baru"), {
    target: { value: "new-password-2" },
  });
  fireEvent.click(submitButton());
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the account the form is bound to", () => {
  it("sends the expected user id it was given as a prop", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "invalid_current_password" } }),
    );
    renderForm();

    fillAndSubmit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe("user-42");
  });
});

describe("a successful change", () => {
  it("signs this device out and sends it to the sign-in page with the changed flag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { changed: true }));
    renderForm();

    fillAndSubmit();

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/auth/login?passwordChanged=1" });
  });
});

describe("a 429 from the server", () => {
  it("with a Retry-After header shows the wait and disables the submit", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: { code: "rate_limited" } }, { "Retry-After": "120" }),
    );
    renderForm();

    fillAndSubmit();

    expect(await screen.findByText(LOCKOUT_WITH_WAIT)).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("with a 120 second Retry-After keeps the panel and the disabled submit until the 120th second", async () => {
    // shouldAdvanceTime lets testing-library's own zero-delay waits resolve under a faked setTimeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: { code: "rate_limited" } }, { "Retry-After": "120" }),
    );
    renderForm();

    fillAndSubmit();
    expect(await screen.findByText(LOCKOUT_WITH_WAIT)).toBeTruthy();
    // The expiry timer is registered by an effect that may still be pending when the panel appears.
    await act(async () => {});

    act(() => {
      vi.advanceTimersByTime(119_000);
    });
    expect(screen.queryByText(LOCKOUT_WITH_WAIT)).not.toBeNull();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText(LOCKOUT_WITH_WAIT)).toBeNull();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("without a Retry-After header shows the panel, keeps the submit enabled, and clears the panel on the next attempt", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { code: "rate_limited" } }));
    renderForm();

    fillAndSubmit();

    expect(await screen.findByText(LOCKOUT_WITHOUT_WAIT)).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "invalid_current_password" } }),
    );
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.queryByText(LOCKOUT_WITHOUT_WAIT)).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("with an unparsable Retry-After header is treated as having no wait", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: { code: "rate_limited" } }, { "Retry-After": "soon" }),
    );
    renderForm();

    fillAndSubmit();

    expect(await screen.findByText(LOCKOUT_WITHOUT_WAIT)).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the toast for an answer", () => {
  it.each([
    ["invalid_current_password", "Password saat ini salah."],
    ["invalid_password", "Password harus 8 sampai 72 karakter."],
  ])("names %s", async (code, message) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code, message: "raw server text" } }),
    );
    renderForm();

    fillAndSubmit();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("is one generic line for an answer the form does not name, never the server's text", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: { code: "boom", message: "raw server text" } }),
    );
    renderForm();

    fillAndSubmit();

    expect(await screen.findByText(GENERIC)).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("is the connection line only when the request itself fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    renderForm();

    fillAndSubmit();

    expect(
      await screen.findByText("Terjadi gangguan koneksi. Coba lagi beberapa saat."),
    ).toBeTruthy();
  });
});
