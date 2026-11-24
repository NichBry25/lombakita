// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { signIn, type SignInResponse } from "next-auth/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { AuthEntry } from "./auth-entry";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/auth/login",
}));

const fetchMock = vi.fn();

const IDENTIFY_URL = "/api/v1/auth/identify";
const REGISTER_URL = "/api/v1/auth/register";
const EMAIL = "andi.saputra@example.test";
const PASSWORD = "rahasia-123";
const PHONE = "081234567890";
const HELP_SENTENCE =
  "Nama ini juga tampil di profil publik Anda dan dapat diubah di halaman profil.";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const answerByUrl = async (url: string) => {
  if (url === IDENTIFY_URL) {
    return jsonResponse(200, { state: "none" });
  }
  if (url.startsWith(REGISTER_URL)) {
    return jsonResponse(200, {});
  }
  throw new Error(`unexpected fetch to ${url}`);
};

const renderEntry = (callbackUrl?: string) =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <AuthEntry googleEnabled={false} verificationEnabled callbackUrl={callbackUrl} />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const reachPasswordConfirm = async (callbackUrl?: string) => {
  renderEntry(callbackUrl);
  fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
  fireEvent.change(screen.getByLabelText(/^Email(?: \* \(wajib\)| \(opsional\))?$/), {
    target: { value: EMAIL },
  });
  fireEvent.change(screen.getByLabelText(/^Password(?: \* \(wajib\)| \(opsional\))?$/), {
    target: { value: PASSWORD },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
  const confirmPassword = await screen.findByLabelText(
    /^Konfirmasi password(?: \* \(wajib\)| \(opsional\))?$/,
  );
  fireEvent.change(confirmPassword, { target: { value: PASSWORD } });
};

const reachDetailsStage = async (callbackUrl?: string) => {
  await reachPasswordConfirm(callbackUrl);
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
  await screen.findByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/);
};

const fillCandidateProfile = (fullName: string) => {
  fireEvent.change(screen.getByLabelText(/^Nama lengkap(?: \* \(wajib\)| \(opsional\))?$/), {
    target: { value: fullName },
  });
  fireEvent.change(screen.getByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/), {
    target: { value: PHONE },
  });
  fireEvent.click(screen.getByRole("button", { name: "Status saat ini (wajib)" }));
  fireEvent.click(screen.getByRole("option", { name: "Mahasiswa" }));
  fireEvent.change(screen.getByLabelText(/^Tanggal lahir(?: \* \(wajib\)| \(opsional\))?$/), {
    target: { value: "2000-01-31" },
  });
};

const submitProfile = () => {
  fireEvent.click(screen.getByRole("button", { name: "Selesai" }));
};

const registerCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(REGISTER_URL));

const sentRegisterBody = async () => {
  await waitFor(() => expect(registerCalls()).toHaveLength(1));
  const init = registerCalls()[0]?.[1];
  return JSON.parse(init.body);
};

const helpLineFor = (inputId: string) => {
  const nameInput = screen.getByLabelText(/^Nama lengkap(?: \* \(wajib\)| \(opsional\))?$/);
  const describedBy = nameInput.getAttribute("aria-describedby");
  const helpText = document.getElementById(`${inputId}-help`)?.textContent?.trim();
  return { describedBy, helpText };
};

beforeEach(() => {
  fetchMock.mockImplementation(answerByUrl);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the email sign-up profile step", () => {
  it("sends the candidate's typed full name as the account name", async () => {
    await reachDetailsStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    const body = await sentRegisterBody();
    expect(body.name).toBe("Andi Saputra");
  });

  it("never sends a one-character full name", async () => {
    await reachDetailsStage();
    fillCandidateProfile("A");

    submitProfile();

    expect(await screen.findByText("Isi nama lengkap (minimal 2 karakter).")).toBeTruthy();
    expect(registerCalls()).toHaveLength(0);
  });

  it("tells a candidate the name is public", async () => {
    await reachDetailsStage();

    const { describedBy, helpText } = helpLineFor("candidate-full-name");

    expect(describedBy).toBe("candidate-full-name-help");
    expect(helpText).toBe(HELP_SENTENCE);
  });

  it("names the refused field when the server refuses the candidate's phone number", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(REGISTER_URL)) {
        return jsonResponse(400, {
          error: {
            code: "candidate_profile_invalid_value",
            message: "x",
            details: { fields: ["phoneNumber"] },
          },
        });
      }
      return answerByUrl(url);
    });
    await reachDetailsStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    expect(await screen.findByText("Isi nomor telepon yang valid (minimal 8 digit).")).toBeTruthy();
  });

  it("shows the verify notice when the server says the email is not yet verified", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(REGISTER_URL)) {
        return jsonResponse(409, { error: { code: "email_not_verified", message: "x" } });
      }
      return answerByUrl(url);
    });
    await reachDetailsStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    expect(await screen.findByText(/belum diverifikasi/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
  });
});

describe("the email sign-up without a role", () => {
  it("offers no role choice when an address has no account", async () => {
    await reachPasswordConfirm();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText(/Daftar sebagai penyelenggara/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    expect(
      await screen.findByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/),
    ).toBeTruthy();
  });

  it("sends the participant details and no role to the register route", async () => {
    await reachDetailsStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    const body = await sentRegisterBody();
    expect(registerCalls()[0]?.[0]).toBe(REGISTER_URL);
    expect(body).toEqual({
      name: "Andi Saputra",
      email: EMAIL,
      password: PASSWORD,
      fullName: "Andi Saputra",
      phoneNumber: PHONE,
      occupation: "college_student",
      dateOfBirth: "2000-01-31",
    });
  });

  it("refuses a confirmation that does not match the password before the details", async () => {
    await reachPasswordConfirm();
    fireEvent.change(
      screen.getByLabelText(/^Konfirmasi password(?: \* \(wajib\)| \(opsional\))?$/),
      { target: { value: "rahasia-999" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    expect(
      await screen.findByText("Password dan konfirmasi password tidak cocok. Coba lagi."),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/)).toBeNull();
  });

  it("keeps the host dashboard as the return address through the code, so the sign-up reaches the host step", async () => {
    await reachDetailsStage("/recruiter-dashboard");
    fillCandidateProfile("Andi Saputra");
    submitProfile();

    fireEvent.change(
      await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/),
      { target: { value: "123456" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ callbackUrl: "/recruiter-dashboard" }),
      ),
    );
  });

  it("tells a new person the next step asks for their details", () => {
    renderEntry();
    fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));

    expect(
      screen.getByText(
        "Belum punya akun? Masukkan email & password, lalu lengkapi data Anda di langkah berikutnya.",
      ),
    ).toBeTruthy();
  });
});

const RESEND_URL = "/api/v1/auth/register/resend";
const RETURN_PATH = "/competitions/acme/lomba-1";

const resendCalls = () => fetchMock.mock.calls.filter(([url]) => url === RESEND_URL);

describe("the email sign-up return address and end stage", () => {
  it("returns to the page it started from once the code is verified", async () => {
    await reachDetailsStage(RETURN_PATH);
    fillCandidateProfile("Andi Saputra");
    submitProfile();

    fireEvent.change(
      await screen.findByLabelText(/^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/),
      {
        target: { value: "123456" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ callbackUrl: RETURN_PATH }),
      ),
    );
    const registerBody = JSON.parse(registerCalls()[0]?.[1].body);
    expect(registerBody).not.toHaveProperty("callbackUrl");
  });

  it("keeps the return address out of the code request", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === IDENTIFY_URL) {
        return jsonResponse(200, { state: "unverified" });
      }
      return answerByUrl(url);
    });
    renderEntry(RETURN_PATH);
    fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
    fireEvent.change(screen.getByLabelText(/^Email(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: EMAIL },
    });
    fireEvent.change(screen.getByLabelText(/^Password(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    fireEvent.click(await screen.findByRole("button", { name: "Lengkapi pendaftaran" }));
    fireEvent.change(
      await screen.findByLabelText(/^Konfirmasi password(?: \* \(wajib\)| \(opsional\))?$/),
      {
        target: { value: PASSWORD },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    fillCandidateProfile("Andi Saputra");
    submitProfile();

    await waitFor(() => expect(resendCalls()).toHaveLength(1));
    const body = JSON.parse(resendCalls()[0]?.[1].body);
    expect(body).toEqual({ email: "andi.saputra@example.test" });
  });

  it("ends email sign-up on the code stage", async () => {
    await reachDetailsStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    const codeBox = await screen.findByLabelText(
      /^Kode verifikasi(?: \* \(wajib\)| \(opsional\))?$/,
    );
    await waitFor(() => expect(document.activeElement).toBe(codeBox));
    const description = document.getElementById(codeBox.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain(EMAIL);
    expect(description?.textContent).toContain("Kode berlaku 10 menit");
    expect(screen.queryByText(/Pendaftaran berhasil/)).toBeNull();
  });

  it("returns the credential sign-in to the page it started from", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === IDENTIFY_URL) {
        return jsonResponse(200, { state: "verified" });
      }
      return answerByUrl(url);
    });
    renderEntry(RETURN_PATH);
    fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
    fireEvent.change(screen.getByLabelText(/^Email(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: EMAIL },
    });
    fireEvent.change(screen.getByLabelText(/^Password(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ callbackUrl: "/competitions/acme/lomba-1" }),
      ),
    );
  });

  it("shows the password rule before typing", () => {
    renderEntry();
    fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));

    expect(screen.getByText("Password minimal 8 karakter.")).toBeTruthy();
    expect(
      screen
        .getByLabelText(/^Password(?: \* \(wajib\)| \(opsional\))?$/)
        .getAttribute("aria-describedby"),
    ).toBe("auth-password-help");
  });
});

describe("after a sign-in", () => {
  it("leaves no flag for the role pop-up after a sign-in", async () => {
    window.sessionStorage.clear();
    const signedInUrl = "http://localhost:3000/competitions/acme/lomba-1";
    fetchMock.mockImplementation(async (url: string) => {
      if (url === IDENTIFY_URL) {
        return jsonResponse(200, { state: "verified" });
      }
      return answerByUrl(url);
    });
    vi.mocked(signIn).mockResolvedValueOnce({
      ok: true,
      url: signedInUrl,
      status: 200,
      error: undefined,
    } as unknown as SignInResponse);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderEntry(RETURN_PATH);
    fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
    fireEvent.change(screen.getByLabelText(/^Email(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: EMAIL },
    });
    fireEvent.change(screen.getByLabelText(/^Password(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(signedInUrl));
    expect(window.sessionStorage.getItem("lombakita:second-role-prompt:pending")).toBeNull();
  });
});
