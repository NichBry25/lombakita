// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { AuthEntry } from "./auth-entry";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));

vi.mock("next-auth/react", () => ({ signIn }));

// PageTransitionProvider reads the pathname.
vi.mock("next/navigation", () => ({
  usePathname: () => "/auth/login",
}));

const ADDRESS = "rina.code@example.test";
const PASSWORD = "owner-pass-2";

type FakeAnswer = { status: number; body: unknown };

const answers = new Map<string, FakeAnswer>();
const fetchMock = vi.fn(async (url: string) => {
  const path = url.split("?")[0]!;
  const answer = answers.get(path);
  if (!answer) throw new Error(`No fake answer for ${path}`);
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => answer.body,
  };
});

const answer = (path: string, status: number, body: unknown) => {
  answers.set(path, { status, body });
};

const postedBodyTo = (path: string): Record<string, unknown> | undefined => {
  const call = fetchMock.mock.calls.find(([url]) => url.split("?")[0] === path);
  if (!call) return undefined;
  const init = (call as unknown[])[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
};

const renderEntry = () =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <AuthEntry googleEnabled={false} verificationEnabled />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const typeInto = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const submitEmailAndPassword = () => {
  fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
  typeInto("Email", ADDRESS);
  typeInto("Password", PASSWORD);
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
};

const reachCodeStageFromVerifyNotice = async () => {
  answer("/api/v1/auth/identify", 200, { state: "unverified" });
  answer("/api/v1/auth/register/resend", 200, { resend: { email: ADDRESS } });
  renderEntry();
  submitEmailAndPassword();
  fireEvent.click(await screen.findByRole("button", { name: "Kirim kode verifikasi" }));
  await screen.findByLabelText("Kode verifikasi");
};

beforeEach(() => {
  answers.clear();
  vi.stubGlobal("fetch", fetchMock);
  signIn.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("verifying an email address with a code on the sign-in page", () => {
  it("asks for the code right after a sign-up", async () => {
    answer("/api/v1/auth/identify", 200, { state: "none" });
    answer("/api/v1/auth/register", 200, { email: ADDRESS });
    renderEntry();
    submitEmailAndPassword();

    await screen.findByLabelText("Konfirmasi password");
    typeInto("Nama lengkap", "Rina Pratama");
    typeInto("Konfirmasi password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: /Daftar sebagai rekruter/ }));
    await screen.findByLabelText("Nomor ponsel");
    typeInto("Nomor ponsel", "0812345678");
    fireEvent.click(screen.getByRole("button", { name: "Selesai" }));

    expect(await screen.findByLabelText("Kode verifikasi")).toBeTruthy();
  });

  it("sends a code from the verify notice and asks for it", async () => {
    await reachCodeStageFromVerifyNotice();

    expect(postedBodyTo("/api/v1/auth/register/resend")).toEqual({ email: ADDRESS });
    expect(screen.getByLabelText("Kode verifikasi")).toBeTruthy();
  });

  it("sends the code with the typed password and signs in", async () => {
    answer("/api/v1/auth/register/verify", 200, { verify: { email: ADDRESS } });
    await reachCodeStageFromVerifyNotice();

    typeInto("Kode verifikasi", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ email: ADDRESS, password: PASSWORD }),
      );
    });
    expect(postedBodyTo("/api/v1/auth/register/verify")).toEqual({
      email: ADDRESS,
      code: "123456",
      password: PASSWORD,
    });
  });

  it("tells the person a wrong code is wrong", async () => {
    answer("/api/v1/auth/register/verify", 400, {
      error: { code: "verification_code_invalid", message: "Kode verifikasi salah." },
    });
    await reachCodeStageFromVerifyNotice();

    typeInto("Kode verifikasi", "000000");
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));

    expect(
      await screen.findByText(
        "Kode salah atau sudah tidak berlaku. Periksa kode di email Anda, atau kirim ulang kode.",
      ),
    ).toBeTruthy();
    expect(signIn).not.toHaveBeenCalled();
  });
});
