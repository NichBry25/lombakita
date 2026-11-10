// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { InstitutionSettingsShell } from "./institution-settings-shell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/institution/academy/settings",
}));

const SETTINGS_URL = "/api/v1/institutions/academy/settings";
const PROFILE_URL = "/api/v1/institutions/academy/profile";
const PAYMENT_INSTRUCTIONS_URL = "/api/v1/institutions/academy/payment-instructions";

const institution = (displayName: string) => ({
  institution: {
    institutionId: "inst_1",
    displayName,
    slug: "academy",
    description: null,
    status: "active",
    institutionType: "university",
    ownerMembership: {
      membershipId: "m_1",
      membershipRole: "institution_owner",
      membershipStatus: "active",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

const PROFILE = {
  profile: {
    about: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    websiteUrl: null,
    logoUrl: null,
    bannerUrl: null,
    socialLinks: [],
    isEditable: false,
  },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const answerByUrlAndMethod = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = `${init?.method ?? "GET"} ${String(input)}`;
  if (request === `GET ${SETTINGS_URL}`) return jsonResponse(200, institution("Akademi Lama"));
  if (request === `GET ${PROFILE_URL}`) return jsonResponse(200, PROFILE);
  if (request === `GET ${PAYMENT_INSTRUCTIONS_URL}`) {
    return jsonResponse(200, { instructions: null });
  }
  if (request === `PATCH ${SETTINGS_URL}`) return jsonResponse(200, institution("Akademi Baru"));
  throw new Error(`unexpected request: ${request}`);
};

const fetchMock = vi.fn(answerByUrlAndMethod);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the account the settings save is bound to", () => {
  it("sends the expected user id with the settings save", async () => {
    render(
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          <InstitutionSettingsShell institutionSlug="academy" expectedUserId="user-42" />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    fireEvent.change(await screen.findByLabelText("Nama institusi"), {
      target: { value: "Akademi Baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true),
    );
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const [url, init] = patchCall;
    expect(String(url)).toBe(SETTINGS_URL);
    expect(new Headers(init?.headers).get("X-Expected-User-Id")).toBe("user-42");
  });

  it("shows the session-changed message when the save is refused for another account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH" && String(input) === SETTINGS_URL) {
          return jsonResponse(409, { error: { code: "session_user_mismatch", message: "x" } });
        }
        return answerByUrlAndMethod(input, init);
      }),
    );
    render(
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          <InstitutionSettingsShell institutionSlug="academy" expectedUserId="user-42" />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    fireEvent.change(await screen.findByLabelText("Nama institusi"), {
      target: { value: "Akademi Baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    expect(
      await screen.findByText("Sesi telah berubah ke akun lain. Muat ulang halaman dan coba lagi."),
    ).toBeTruthy();
  });
});
