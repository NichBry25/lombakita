// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const renderEntry = () =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <AuthEntry googleEnabled={false} verificationEnabled />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const chooseRole = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
};

const reachRoleChoice = async () => {
  renderEntry();
  fireEvent.click(screen.getByRole("button", { name: /Lanjut dengan email/ }));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
  const confirmPassword = await screen.findByLabelText("Konfirmasi password");
  fireEvent.change(confirmPassword, { target: { value: PASSWORD } });
};

const reachCandidateStage = async () => {
  await reachRoleChoice();
  chooseRole("Daftar sebagai kandidat");
};

const reachRecruiterStage = async () => {
  await reachRoleChoice();
  chooseRole("Daftar sebagai rekruter");
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
  });
});
