// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { signIn } from "next-auth/react";
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

const chooseRole = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
};

const reachRoleChoice = async (callbackUrl?: string) => {
  renderEntry(callbackUrl);
  fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
  const confirmPassword = await screen.findByLabelText("Konfirmasi password");
  fireEvent.change(confirmPassword, { target: { value: PASSWORD } });
};

const reachCandidateStage = async (callbackUrl?: string) => {
  await reachRoleChoice(callbackUrl);
  chooseRole("Daftar sebagai kandidat");
};

const reachRecruiterStage = async () => {
  await reachRoleChoice();
  chooseRole("Daftar sebagai penyelenggara");
};

const fillCandidateProfile = (fullName: string) => {
  fireEvent.change(screen.getByLabelText("Nama lengkap"), { target: { value: fullName } });
  fireEvent.change(screen.getByLabelText("Nomor telepon"), { target: { value: PHONE } });
  fireEvent.click(screen.getByRole("button", { name: "Status saat ini" }));
  fireEvent.click(screen.getByRole("option", { name: "Mahasiswa" }));
  fireEvent.change(screen.getByLabelText("Tanggal lahir"), { target: { value: "2000-01-31" } });
};

const fillRecruiterProfile = (fullName: string) => {
  fireEvent.change(screen.getByLabelText("Nama lengkap"), { target: { value: fullName } });
  fireEvent.change(screen.getByLabelText("Nomor ponsel"), { target: { value: PHONE } });
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
  const nameInput = screen.getByLabelText("Nama lengkap");
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
    await reachCandidateStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    const body = await sentRegisterBody();
    expect(body.name).toBe("Andi Saputra");
  });

  it("sends the recruiter's typed full name as the account name", async () => {
    await reachRecruiterStage();
    fillRecruiterProfile("Andi Saputra");

    submitProfile();

    const body = await sentRegisterBody();
    expect(body.name).toBe("Andi Saputra");
  });

  it("never sends a one-character full name", async () => {
    await reachCandidateStage();
    fillCandidateProfile("A");

    submitProfile();

    expect(await screen.findByText("Isi nama lengkap (minimal 2 karakter).")).toBeTruthy();
    expect(registerCalls()).toHaveLength(0);
  });

  it("tells a candidate the name is public", async () => {
    await reachCandidateStage();

    const { describedBy, helpText } = helpLineFor("candidate-full-name");

    expect(describedBy).toBe("candidate-full-name-help");
    expect(helpText).toBe(HELP_SENTENCE);
  });

  it("tells a recruiter the name is public", async () => {
    await reachRecruiterStage();

    const { describedBy, helpText } = helpLineFor("recruiter-full-name");

    expect(describedBy).toBe("recruiter-full-name-help");
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
    await reachCandidateStage();
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
    await reachCandidateStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    expect(await screen.findByText(/belum diverifikasi/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
  });
});

const RESEND_URL = "/api/v1/auth/register/resend";
const RETURN_PATH = "/competitions/acme/lomba-1";

const resendCalls = () => fetchMock.mock.calls.filter(([url]) => url === RESEND_URL);

describe("the email sign-up return address and end stage", () => {
  it("sends the return address with the email sign-up", async () => {
    await reachCandidateStage(RETURN_PATH);
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    const body = await sentRegisterBody();
    expect(body.callbackUrl).toBe(RETURN_PATH);
  });

  it("sends the return address with a resent verification", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === IDENTIFY_URL) {
        return jsonResponse(200, { state: "unverified" });
      }
      return answerByUrl(url);
    });
    renderEntry(RETURN_PATH);
    fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    const resendButton = await screen.findByRole("button", { name: "Kirim ulang verifikasi" });
    fireEvent.click(resendButton);

    await waitFor(() => expect(resendCalls()).toHaveLength(1));
    const body = JSON.parse(resendCalls()[0]?.[1].body);
    expect(body).toEqual({ email: "andi.saputra@example.test", callbackUrl: RETURN_PATH });
  });

  it("ends email sign-up on the check-email stage", async () => {
    await reachCandidateStage();
    fillCandidateProfile("Andi Saputra");

    submitProfile();

    expect(await screen.findByText("Periksa email Anda.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kirim ulang verifikasi" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
    expect(document.activeElement?.textContent).toContain("Periksa email Anda.");
    expect(document.activeElement?.textContent).toContain(EMAIL);
    expect(document.activeElement?.textContent).toContain("Tautan berlaku 24 jam");
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
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
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
    expect(screen.getByLabelText("Password").getAttribute("aria-describedby")).toBe(
      "auth-password-help",
    );
  });
});
