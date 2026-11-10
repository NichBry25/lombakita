// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { VerifyRoleForm } from "./verify-role-form";

vi.mock("next-auth/react", () => ({ useSession: () => ({ update: vi.fn() }) }));

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

describe("the account the role form is bound to", () => {
  it("sends the expected user id and shows the session-changed message on a mismatch", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === VERIFY_ROLE_URL) {
        return jsonResponse(409, { error: { code: "session_user_mismatch", message: "x" } });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    render(
      <UIPrimitivesProvider>
        <VerifyRoleForm role="recruiter" expectedUserId="user-42" />
      </UIPrimitivesProvider>,
    );

    fireEvent.change(screen.getByLabelText("Nama lengkap"), {
      target: { value: "Andi Saputra" },
    });
    fireEvent.change(screen.getByLabelText("Nomor ponsel"), {
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
