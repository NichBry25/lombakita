// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { SESSION_MISMATCH_MESSAGE } from "@/lib/session/session-fetch";
import { OrganizationEmailField } from "./organization-email-field";

vi.mock("next/navigation", () => ({ usePathname: () => "/auth/verify-role" }));

const CODE_URL = "/api/v1/me/organization-email/code";
const CONFIRM_URL = "/api/v1/me/organization-email/confirm";
const ADDRESS = "sekretaris@kampus.example";
const CODE_BOX_LABEL = /^Kode 6 angka(?: \* \(wajib\)| \(opsional\))?$/;

const fetchMock = vi.fn();
let answerFor: Record<string, () => Response> = {};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sentCode = () =>
  jsonResponse(200, {
    organizationEmailCode: { email: ADDRESS, expiresAt: "2026-11-25T10:10:00.000Z" },
  });

const refusal =
  (status: number, code: string, message: string, details?: Record<string, number>) => () =>
    jsonResponse(status, { error: { code, message, details } });

const requestTo = (url: string): RequestInit | undefined => {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
  return call?.[1] as RequestInit | undefined;
};

const renderField = () =>
  render(
    <UIPrimitivesProvider>
      <OrganizationEmailField expectedUserId="user-42" />
    </UIPrimitivesProvider>,
  );

const sendCodeTo = (address: string) => {
  fireEvent.change(screen.getByLabelText(/^Email organisasi(?: \(opsional\))?$/), {
    target: { value: address },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Kirim/ }));
};

const confirmCode = async (code: string) => {
  fireEvent.change(await screen.findByLabelText(CODE_BOX_LABEL), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Cocokkan kode" }));
};

beforeEach(() => {
  answerFor = {};
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const answer = answerFor[String(input)];
    if (!answer) throw new Error(`unexpected request: ${String(input)}`);
    return answer();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the Email organisasi field", () => {
  it("sends the typed address with the expected user id and opens the code box", async () => {
    answerFor[CODE_URL] = sentCode;
    renderField();

    sendCodeTo(ADDRESS);

    const codeBox = await screen.findByLabelText(CODE_BOX_LABEL);
    const init = requestTo(CODE_URL);
    expect(new Headers(init?.headers).get("X-Expected-User-Id")).toBe("user-42");
    expect(JSON.parse(String(init?.body))).toEqual({ email: ADDRESS });
    expect(document.getElementById("organization-email-code-help")?.textContent).toBe(
      "Kode dikirim ke sekretaris@kampus.example dan berlaku 10 menit.",
    );
    await waitFor(() => expect(document.activeElement).toBe(codeBox));
  });

  it("holds the resend for 60 seconds after a send, and not a second longer", async () => {
    // shouldAdvanceTime lets testing-library's own zero-delay waits resolve under a faked setTimeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-25T10:00:00.000Z"));
    answerFor[CODE_URL] = sentCode;
    renderField();

    sendCodeTo(ADDRESS);
    await screen.findByLabelText(CODE_BOX_LABEL);
    // The countdown tick is registered by an effect that may still be pending when the state appears.
    await act(async () => {});
    const sendButton = () =>
      screen.getByRole("button", { name: /^Kirim ulang/ }) as HTMLButtonElement;
    expect(sendButton().textContent).toBe("Kirim ulang dalam 60 detik");

    for (let second = 0; second < 59; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toBe("Kirim ulang dalam 1 detik");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent).toBe("Kirim ulang kode");
  });

  it("confirms the code with the expected user id and shows the confirmed address", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = () =>
      jsonResponse(200, { organizationEmail: { email: ADDRESS, trustSource: null } });
    renderField();

    sendCodeTo(ADDRESS);
    await confirmCode("123456");

    expect(
      await screen.findByText("Email organisasi sekretaris@kampus.example sudah terkonfirmasi."),
    ).toBeTruthy();
    const init = requestTo(CONFIRM_URL);
    expect(new Headers(init?.headers).get("X-Expected-User-Id")).toBe("user-42");
    expect(JSON.parse(String(init?.body))).toEqual({ code: "123456" });
    expect(screen.queryByLabelText(CODE_BOX_LABEL)).toBeNull();
  });

  it("says how many tries are left after a wrong code", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = refusal(422, "organization_email_code_invalid", "raw server text", {
      attemptsLeft: 3,
    });
    renderField();

    sendCodeTo(ADDRESS);
    await confirmCode("000000");

    expect(await screen.findByText("Kode tidak cocok. Sisa percobaan: 3.")).toBeTruthy();
  });

  it("says how long to wait when a code was sent too recently", async () => {
    answerFor[CODE_URL] = refusal(429, "organization_email_resend_too_soon", "raw server text", {
      retryAfterSeconds: 42,
    });
    renderField();

    sendCodeTo(ADDRESS);

    expect(await screen.findByText("Tunggu 42 detik sebelum meminta kode baru.")).toBeTruthy();
    expect(screen.queryByLabelText(CODE_BOX_LABEL)).toBeNull();
  });

  it("shows the domain-limit sentence the server sends for a locked code", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = refusal(
      422,
      "organization_email_code_locked",
      "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.",
    );
    renderField();

    sendCodeTo(ADDRESS);
    await confirmCode("123456");

    expect(
      await screen.findByText(
        "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.",
      ),
    ).toBeTruthy();
  });

  it("shows the wait-and-request sentence the server sends when the code cannot be checked", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = refusal(
      422,
      "organization_email_code_locked",
      "Kode belum dapat diperiksa saat ini. Tunggu beberapa menit sebelum mencoba lagi, atau minta kode baru.",
    );
    renderField();

    sendCodeTo(ADDRESS);
    await confirmCode("123456");

    expect(
      await screen.findByText(
        "Kode belum dapat diperiksa saat ini. Tunggu beberapa menit sebelum mencoba lagi, atau minta kode baru.",
      ),
    ).toBeTruthy();
  });

  it("shows the five-tries sentence for a locked code whose server text it does not hold", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = refusal(422, "organization_email_code_locked", "raw server text");
    renderField();

    sendCodeTo(ADDRESS);
    await confirmCode("123456");

    expect(await screen.findByText("Kode salah 5 kali. Minta kode baru.")).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("names each refusal of a send in its own words", async () => {
    renderField();
    const rows = [
      [400, "organization_email_invalid", "Alamat email belum benar. Periksa lagi penulisannya."],
      [
        422,
        "organization_email_free_domain",
        "Pakai email dengan domain organisasi Anda, bukan email pribadi seperti Gmail atau email sementara.",
      ],
      [
        429,
        "organization_email_daily_limit",
        "Batas pengiriman kode hari ini sudah tercapai. Coba lagi besok.",
      ],
    ] as const;

    for (const [status, code, sentence] of rows) {
      answerFor[CODE_URL] = refusal(status, code, "raw server text");
      sendCodeTo(ADDRESS);
      expect(await screen.findByText(sentence)).toBeTruthy();
    }

    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("names each refusal of a confirm in its own words", async () => {
    answerFor[CODE_URL] = sentCode;
    renderField();
    sendCodeTo(ADDRESS);
    const rows = [
      [422, "organization_email_code_expired", "Kode sudah kedaluwarsa. Minta kode baru."],
      [404, "organization_email_no_code", "Belum ada kode yang aktif. Minta kode terlebih dahulu."],
      [
        409,
        "organization_email_taken",
        "Email ini sudah dipakai akun lain. Satu email organisasi hanya untuk satu akun.",
      ],
    ] as const;

    for (const [status, code, sentence] of rows) {
      answerFor[CONFIRM_URL] = refusal(status, code, "raw server text");
      await confirmCode("123456");
      expect(await screen.findByText(sentence)).toBeTruthy();
    }

    expect(screen.queryByText("raw server text")).toBeNull();
  });

  it("shows the session-changed sentence when the account changed in another tab", async () => {
    answerFor[CODE_URL] = refusal(409, "session_user_mismatch", "raw server text");
    renderField();

    sendCodeTo(ADDRESS);

    expect(await screen.findByText(SESSION_MISMATCH_MESSAGE)).toBeTruthy();
  });

  it("says the connection failed only when the request itself fails", async () => {
    answerFor[CODE_URL] = () => {
      throw new TypeError("network down");
    };
    renderField();

    sendCodeTo(ADDRESS);

    expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeTruthy();
  });

  it("shows its own sentence for a send refusal it does not name", async () => {
    answerFor[CODE_URL] = refusal(500, "unmapped_refusal_code", "raw server text");
    renderField();

    sendCodeTo(ADDRESS);

    expect(
      await screen.findByText("Kode belum dapat dikirim. Coba lagi beberapa saat."),
    ).toBeTruthy();
    expect(screen.queryByText("raw server text")).toBeNull();
  });
});
