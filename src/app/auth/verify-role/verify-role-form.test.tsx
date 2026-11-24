// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { VerifyRoleForm } from "./verify-role-form";

vi.mock("next-auth/react", () => ({ useSession: () => ({ update: vi.fn() }) }));

// PageTransitionProvider reads the pathname.
vi.mock("next/navigation", () => ({ usePathname: () => "/auth/verify-role" }));

const VERIFY_ROLE_URL = "/api/v1/auth/verify-role";
const REGISTERED_CONTACT = { fullName: "Andi Saputra", phoneNumber: "081234567890" };

const fetchMock = vi.fn();

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderForm = (form: ReactNode) =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>{form}</PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

describe("the account the role form is bound to", () => {
  it("sends the expected user id and shows the session-changed message on a mismatch", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === VERIFY_ROLE_URL) {
        return jsonResponse(409, { error: { code: "session_user_mismatch", message: "x" } });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    renderForm(
      <VerifyRoleForm
        role="recruiter"
        expectedUserId="user-42"
        returnPath={null}
        registeredContact={REGISTERED_CONTACT}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mulai menyelenggarakan" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(VERIFY_ROLE_URL);
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe("user-42");
    expect(
      await screen.findByText("Sesi telah berubah ke akun lain. Muat ulang halaman dan coba lagi."),
    ).toBeTruthy();
  });
});

describe("where the role form goes once the role is added", () => {
  const answerVerified = () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === VERIFY_ROLE_URL) {
        return jsonResponse(200, { verified: "candidate", redirectTo: "/candidate-dashboard" });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
  };

  const stubNavigation = () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    return assign;
  };

  const fillCandidateForm = () => {
    fireEvent.change(screen.getByLabelText(/^Nama lengkap(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: "Andi Saputra" },
    });
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

  it("returns to the competition after the participant role is added", async () => {
    answerVerified();
    const assign = stubNavigation();
    renderForm(
      <VerifyRoleForm
        role="candidate"
        expectedUserId="user-42"
        returnPath="/competitions/acme/lomba-1"
        registeredContact={null}
      />,
    );

    fillCandidateForm();

    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign).toHaveBeenCalledWith("/competitions/acme/lomba-1");
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe("user-42");
    expect(await screen.findByText("Menyiapkan akun Anda…")).toBeTruthy();
  });

  it("goes to the dashboard the server names when there is no return address", async () => {
    answerVerified();
    const assign = stubNavigation();
    renderForm(
      <VerifyRoleForm
        role="candidate"
        expectedUserId="user-42"
        returnPath={null}
        registeredContact={null}
      />,
    );

    fillCandidateForm();

    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign).toHaveBeenCalledWith("/candidate-dashboard");
    expect(await screen.findByText("Menyiapkan akun Anda…")).toBeTruthy();
  });

  const answerHostStep = (hostTrusted: boolean) => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === VERIFY_ROLE_URL) {
        return jsonResponse(200, {
          verified: "recruiter",
          redirectTo: "/recruiter-dashboard",
          hostTrusted,
        });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
  };

  const renderHostStep = () =>
    renderForm(
      <VerifyRoleForm
        role="recruiter"
        expectedUserId="user-42"
        returnPath={null}
        registeredContact={REGISTERED_CONTACT}
      />,
    );

  it("sends only the role from the host step and goes on when the account is not yet trusted", async () => {
    answerHostStep(false);
    const assign = stubNavigation();
    renderHostStep();

    fireEvent.click(screen.getByRole("button", { name: "Mulai menyelenggarakan" }));

    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign).toHaveBeenCalledWith("/recruiter-dashboard");
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ role: "recruiter" });
    expect(await screen.findByText("Menyiapkan akun Anda…")).toBeTruthy();
  });

  it("says the account is trusted and waits for the host to go on", async () => {
    answerHostStep(true);
    const assign = stubNavigation();
    renderHostStep();

    fireEvent.click(screen.getByRole("button", { name: "Mulai menyelenggarakan" }));

    expect(
      await screen.findByText(
        "Akun Anda tepercaya. Kompetisi yang Anda terbitkan langsung tayang.",
      ),
    ).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Lanjut" }).getAttribute("href")).toBe(
      "/recruiter-dashboard",
    );
    expect(screen.queryByRole("button", { name: "Mulai menyelenggarakan" })).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute("tabindex")).toBe("-1"));
  });

  it("goes on after the participant step even when the answer says the account is trusted", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === VERIFY_ROLE_URL) {
        return jsonResponse(200, {
          verified: "candidate",
          redirectTo: "/candidate-dashboard",
          hostTrusted: true,
        });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const assign = stubNavigation();
    renderForm(
      <VerifyRoleForm
        role="candidate"
        expectedUserId="user-42"
        returnPath={null}
        registeredContact={null}
      />,
    );

    fillCandidateForm();

    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign).toHaveBeenCalledWith("/candidate-dashboard");
  });
});

describe("the host step form", () => {
  const renderHostStepWith = (registeredContact: typeof REGISTERED_CONTACT | null) =>
    renderForm(
      <VerifyRoleForm
        role="recruiter"
        expectedUserId="user-42"
        returnPath={null}
        registeredContact={registeredContact}
      />,
    );

  it("shows the name and phone from sign-up as locked values", () => {
    renderHostStepWith(REGISTERED_CONTACT);

    const nameField = screen.getByLabelText("Nama") as HTMLInputElement;
    const phoneField = screen.getByLabelText("Nomor ponsel") as HTMLInputElement;
    expect(nameField.value).toBe("Andi Saputra");
    expect(nameField.readOnly).toBe(true);
    expect(phoneField.value).toBe("081234567890");
    expect(phoneField.readOnly).toBe(true);
    expect(
      screen.getByText("Nama dan nomor ponsel diambil dari data pendaftaran Anda."),
    ).toBeTruthy();
  });

  it("shows no sign-up values when the account has none", () => {
    renderHostStepWith(null);

    expect(screen.queryByLabelText("Nama")).toBeNull();
    expect(
      screen.queryByText("Nama dan nomor ponsel diambil dari data pendaftaran Anda."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Mulai menyelenggarakan" })).toBeTruthy();
  });

  it("offers the optional Email organisasi and says what happens without it", () => {
    renderHostStepWith(REGISTERED_CONTACT);

    expect(screen.getByLabelText(/^Email organisasi(?: \(opsional\))?$/)).toBeTruthy();
    expect(
      screen.getByText(
        "Tanpa email organisasi, kompetisi pertama Anda diperiksa staf sebelum tayang. Perkiraan 1x24 jam pada hari kerja.",
      ),
    ).toBeTruthy();
  });
});
