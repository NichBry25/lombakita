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
  const labelWithoutMarker = (content: string) =>
    content.replace(/ \* \(wajib\)$| \(opsional\)$/, "");
  fireEvent.change(
    screen.getByLabelText((content) => labelWithoutMarker(content) === label),
    { target: { value } },
  );
};

const submitEmailAndPassword = (password: string = PASSWORD) => {
  fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
  typeInto("Email", ADDRESS);
  typeInto("Password", password);
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
};

const PARTICIPANT_VERIFY_BODY = {
  email: ADDRESS,
  code: "123456",
  password: PASSWORD,
  name: "Rina Pratama",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-31",
};

const fillSignUpForm = async (confirmPassword: string = PASSWORD) => {
  await screen.findByLabelText(/^Konfirmasi password(?: \* \(wajib\)| \(opsional\))?$/);
  typeInto("Konfirmasi password", confirmPassword);
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
  await screen.findByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/);
  typeInto("Nama lengkap", "Rina Pratama");
  typeInto("Nomor telepon", "0812345678");
  fireEvent.click(screen.getByRole("combobox", { name: "Status saat ini (wajib)" }));
  fireEvent.click(screen.getByRole("option", { name: "Mahasiswa" }));
  typeInto("Tanggal lahir", "2000-01-31");
  fireEvent.click(screen.getByRole("button", { name: "Selesai" }));
};

const signUpAsParticipant = async () => {
  answer("/api/v1/auth/identify", 200, { state: "none" });
  renderEntry();
  submitEmailAndPassword();

  await fillSignUpForm();
};

const submitCode = (code: string) => {
  typeInto("Kode verifikasi", code);
  fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));
};

const reachCodeStageFromVerifyNotice = async () => {
  answer("/api/v1/auth/identify", 200, { state: "unverified" });
  answer("/api/v1/auth/register/resend", 200, { resend: { email: ADDRESS } });
  renderEntry();
  submitEmailAndPassword();
  fireEvent.click(await screen.findByRole("button", { name: "Lengkapi pendaftaran" }));
  await fillSignUpForm();
  await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/);
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
    answer("/api/v1/auth/register", 200, { email: ADDRESS });
    await signUpAsParticipant();

    expect(
      await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/),
    ).toBeTruthy();
  });

  it("moves focus to the code box when the code stage opens", async () => {
    answer("/api/v1/auth/register", 200, { email: ADDRESS });
    await signUpAsParticipant();

    const codeBox = await screen.findByLabelText(
      /^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(codeBox);
    });
  });

  it("offers the code for an address that already has an account", async () => {
    answer("/api/v1/auth/register", 409, {
      error: { code: "email_not_verified", message: "An unverified account already exists" },
    });
    await signUpAsParticipant();

    expect(await screen.findByRole("button", { name: "Kirim kode verifikasi" })).toBeTruthy();
  });

  it("names the network limit when the network is limited", async () => {
    answer("/api/v1/auth/register/verify", 429, {
      error: { code: "rate_limited", message: "Too many requests" },
    });
    await reachCodeStageFromVerifyNotice();

    submitCode("123456");

    expect(
      await screen.findByText(
        "Terlalu banyak permintaan dari jaringan ini. Tunggu beberapa menit lalu coba lagi.",
      ),
    ).toBeTruthy();
  });

  it("says the address is verified when the sign-in after it fails", async () => {
    answer("/api/v1/auth/register/verify", 200, { verify: { email: ADDRESS } });
    signIn.mockRejectedValue(new Error("network down"));
    await reachCodeStageFromVerifyNotice();

    submitCode("123456");

    expect(
      await screen.findByText("Email berhasil diverifikasi. Silakan masuk dengan password Anda."),
    ).toBeTruthy();
  });

  it("does not send a code for a password the server would refuse", async () => {
    answer("/api/v1/auth/identify", 200, { state: "unverified" });
    answer("/api/v1/auth/register/resend", 200, { resend: { email: ADDRESS } });
    renderEntry();
    submitEmailAndPassword("short6");

    fireEvent.click(await screen.findByRole("button", { name: "Lengkapi pendaftaran" }));
    await fillSignUpForm("short6");

    expect(
      await screen.findByText(
        "Password harus 8 sampai 72 karakter. Kembali, lalu masukkan password yang memenuhi syarat.",
      ),
    ).toBeTruthy();
    expect(postedBodyTo("/api/v1/auth/register/resend")).toBeUndefined();
  });

  it("sends a code from the verify notice and asks for it", async () => {
    await reachCodeStageFromVerifyNotice();

    expect(postedBodyTo("/api/v1/auth/register/resend")).toEqual({ email: ADDRESS });
    expect(screen.getByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/)).toBeTruthy();
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
    expect(postedBodyTo("/api/v1/auth/register/verify")).toEqual(PARTICIPANT_VERIFY_BODY);
  });

  it("sends the sign-up details with the code", async () => {
    answer("/api/v1/auth/register", 200, { email: ADDRESS });
    answer("/api/v1/auth/register/verify", 200, { verify: { email: ADDRESS } });
    await signUpAsParticipant();
    await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/);

    submitCode("123456");

    await waitFor(() => {
      expect(postedBodyTo("/api/v1/auth/register/verify")).toEqual(PARTICIPANT_VERIFY_BODY);
    });
  });

  it("asks for the sign-up details before sending a code to an unverified address", async () => {
    answer("/api/v1/auth/identify", 200, { state: "unverified" });
    answer("/api/v1/auth/register/resend", 200, { resend: { email: ADDRESS } });
    renderEntry();
    submitEmailAndPassword();

    const completeSignUp = await screen.findByRole("button", { name: "Lengkapi pendaftaran" });
    expect(screen.queryByRole("button", { name: "Kirim kode verifikasi" })).toBeNull();

    fireEvent.click(completeSignUp);
    expect(
      await screen.findByText(
        "Setelah data Anda lengkap, kami kirim kode verifikasi ke email ini.",
        { exact: false },
      ),
    ).toBeTruthy();
    await fillSignUpForm();

    expect(
      await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/),
    ).toBeTruthy();
    expect(postedBodyTo("/api/v1/auth/register/resend")).toEqual({ email: ADDRESS });
    expect(postedBodyTo("/api/v1/auth/register")).toBeUndefined();
  });

  it("sends a code at once when the sign-up details are already filled", async () => {
    answer("/api/v1/auth/register", 409, {
      error: { code: "email_not_verified", message: "An unverified account already exists" },
    });
    answer("/api/v1/auth/register/resend", 200, { resend: { email: ADDRESS } });
    await signUpAsParticipant();

    fireEvent.click(await screen.findByRole("button", { name: "Kirim kode verifikasi" }));

    expect(
      await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/),
    ).toBeTruthy();
    expect(postedBodyTo("/api/v1/auth/register/resend")).toEqual({ email: ADDRESS });
  });

  it("forgets the sign-up details when the person goes back", async () => {
    answer("/api/v1/auth/register", 409, {
      error: { code: "email_not_verified", message: "An unverified account already exists" },
    });
    await signUpAsParticipant();
    await screen.findByRole("button", { name: "Kirim kode verifikasi" });

    fireEvent.click(screen.getByRole("button", { name: "Kembali" }));
    answer("/api/v1/auth/identify", 200, { state: "unverified" });
    typeInto("Password", PASSWORD);
    fireEvent.click(await screen.findByRole("button", { name: "Lanjut" }));

    expect(await screen.findByRole("button", { name: "Lengkapi pendaftaran" })).toBeTruthy();
  });

  it("empties the sign-up form when the person goes back to the email step", async () => {
    answer("/api/v1/auth/register", 200, { email: ADDRESS });
    await signUpAsParticipant();
    await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/);

    fireEvent.click(screen.getByRole("button", { name: "Kembali" }));

    const emailField = (await screen.findByLabelText(
      /^Email(?: \* \(wajib\)| \(opsional\))?$/,
    )) as HTMLInputElement;
    expect(emailField.value).toBe(ADDRESS);
    const passwordField = screen.getByLabelText(
      /^Password(?: \* \(wajib\)| \(opsional\))?$/,
    ) as HTMLInputElement;
    expect(passwordField.value).toBe("");

    answer("/api/v1/auth/identify", 200, { state: "unverified" });
    typeInto("Password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    fireEvent.click(await screen.findByRole("button", { name: "Lengkapi pendaftaran" }));

    const confirmPasswordField = (await screen.findByLabelText(
      /^Konfirmasi password(?: \* \(wajib\)| \(opsional\))?$/,
    )) as HTMLInputElement;
    expect(confirmPasswordField.value).toBe("");

    typeInto("Konfirmasi password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    const phoneNumberField = (await screen.findByLabelText(
      /^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/,
    )) as HTMLInputElement;
    const candidateNameField = screen.getByLabelText(
      /^Nama lengkap(?: \* \(wajib\)| \(opsional\))?$/,
    ) as HTMLInputElement;
    expect(candidateNameField.value).toBe("");
    expect(phoneNumberField.value).toBe("");
  });

  it("says to try again in 24 hours after too many wrong codes in a day", async () => {
    answer("/api/v1/auth/register", 200, { email: ADDRESS });
    answer("/api/v1/auth/register/verify", 429, {
      error: { code: "verification_code_daily_limit", message: "Too many wrong codes" },
    });
    await signUpAsParticipant();
    await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/);

    submitCode("123456");

    expect(
      await screen.findByText(
        "Terlalu banyak percobaan kode yang salah untuk email ini. Coba lagi dalam 24 jam.",
      ),
    ).toBeTruthy();
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

  it("sends the person back to the form when the server refuses a detail", async () => {
    answer("/api/v1/auth/register/verify", 400, {
      error: {
        code: "candidate_profile_invalid_value",
        message: "phoneNumber must be a valid phone number",
      },
    });
    await reachCodeStageFromVerifyNotice();

    submitCode("123456");

    expect(
      await screen.findByText(
        "Data pendaftaran belum sesuai. Periksa kembali isian Anda, lalu lanjutkan lagi.",
      ),
    ).toBeTruthy();
    const phoneNumberField = (await screen.findByLabelText(
      /^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/,
    )) as HTMLInputElement;
    expect(phoneNumberField.value).toBe("0812345678");
  });
});
