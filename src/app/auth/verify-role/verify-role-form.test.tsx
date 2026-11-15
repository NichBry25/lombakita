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
    renderForm(<VerifyRoleForm role="recruiter" expectedUserId="user-42" returnPath={null} />);

    fireEvent.change(screen.getByLabelText(/^Nama lengkap(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: "Andi Saputra" },
    });
    fireEvent.change(screen.getByLabelText(/^Nomor ponsel(?: \* \(wajib\)| \(opsional\))?$/), {
      target: { value: "081234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Selesai" }));

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
    renderForm(<VerifyRoleForm role="candidate" expectedUserId="user-42" returnPath={null} />);

    fillCandidateForm();

    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign).toHaveBeenCalledWith("/candidate-dashboard");
    expect(await screen.findByText("Menyiapkan akun Anda…")).toBeTruthy();
  });
});
