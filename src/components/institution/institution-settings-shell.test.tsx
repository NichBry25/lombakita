// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import type { TickPath } from "@/server/institution-verification/tick-transition";
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
          <InstitutionSettingsShell
            institutionSlug="academy"
            expectedUserId="user-42"
            tickPath={null}
          />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    fireEvent.change(
      await screen.findByLabelText(/^Nama institusi(?: \* \(wajib\)| \(opsional\))?$/),
      {
        target: { value: "Akademi Baru" },
      },
    );
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
          <InstitutionSettingsShell
            institutionSlug="academy"
            expectedUserId="user-42"
            tickPath={null}
          />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    fireEvent.change(
      await screen.findByLabelText(/^Nama institusi(?: \* \(wajib\)| \(opsional\))?$/),
      {
        target: { value: "Akademi Baru" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    expect(
      await screen.findByText("Sesi telah berubah ke akun lain. Muat ulang halaman dan coba lagi."),
    ).toBeTruthy();
  });
});

describe("InstitutionSettingsShell payment instructions refusals", () => {
  it("tells an owner whose trust staff removed that the payment instructions stay as they are", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT" && String(input) === PAYMENT_INSTRUCTIONS_URL) {
          return jsonResponse(403, {
            error: { code: "payment_instructions_blocked_trust_removed", message: "x" },
          });
        }
        return answerByUrlAndMethod(input, init);
      }),
    );
    render(
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          <InstitutionSettingsShell
            institutionSlug="academy"
            expectedUserId="user-42"
            tickPath={null}
          />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Simpan informasi pembayaran" }));

    expect(
      await screen.findByText(
        "Status tepercaya akun Anda dicabut staf, jadi informasi pembayaran tidak dapat Anda ubah. Minta pemilik lain di ruang kerja ini mengubahnya, atau hubungi staf Lombakita.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Informasi pembayaran gagal disimpan. Coba lagi.")).toBeNull();
  });
});

describe("a personal workspace's identity in settings", () => {
  it("edits the name and the address of a personal workspace", async () => {
    const personalSettings = institution("Akademi Pribadi");
    personalSettings.institution.institutionType = "personal";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && String(input) === SETTINGS_URL) {
          return jsonResponse(200, personalSettings);
        }
        return answerByUrlAndMethod(input, init);
      }),
    );
    render(
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          <InstitutionSettingsShell
            institutionSlug="academy"
            expectedUserId="user-42"
            tickPath={null}
          />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    const nameInput = (await screen.findByLabelText(
      /^Nama institusi(?: \* \(wajib\)| \(opsional\))?$/,
    )) as HTMLInputElement;
    const slugInput = screen.getByLabelText(
      /^Slug(?: \* \(wajib\)| \(opsional\))?$/,
    ) as HTMLInputElement;

    expect(nameInput.readOnly).toBe(false);
    expect(nameInput.required).toBe(true);
    expect(slugInput.readOnly).toBe(false);
    expect(slugInput.required).toBe(true);
    expect(screen.queryByText("mengikuti username", { exact: false })).toBeNull();

    fireEvent.change(nameInput, { target: { value: "Akademi Baru" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    await waitFor(() => expect(fetchCalls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patchCall = fetchCalls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patchCall[1].body))).toEqual({
      displayName: "Akademi Baru",
      slug: "academy",
    });
  });
});

describe("the organizer profile section of settings", () => {
  it("shows the organizer profile section once the profile read succeeds", async () => {
    render(
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          <InstitutionSettingsShell
            institutionSlug="academy"
            expectedUserId="user-42"
            tickPath={null}
          />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Profil penyelenggara" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Simpan profil" })).toBeTruthy();
  });

  it("keeps the organizer profile section hidden when the profile read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && String(input) === PROFILE_URL) {
          return jsonResponse(500, {});
        }
        return answerByUrlAndMethod(input, init);
      }),
    );
    render(
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          <InstitutionSettingsShell
            institutionSlug="academy"
            expectedUserId="user-42"
            tickPath={null}
          />
        </PageTransitionProvider>
      </UIPrimitivesProvider>,
    );

    expect(await screen.findByText("Gagal memuat profil penyelenggara.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Profil penyelenggara" })).toBeNull();
  });
});

const NAME_LABEL = /^Nama institusi(?: \* \(wajib\)| \(opsional\))?$/;
const SLUG_LABEL = /^Slug(?: \* \(wajib\)| \(opsional\))?$/;
const WEBSITE_LABEL = /^Website(?: \* \(wajib\)| \(opsional\))?$/;

const WARNING_TITLE = "Centang akan dicabut";
const NAME_WARNING_BODY =
  "Nama baru berbeda dari nama yang sudah diperiksa, jadi ruang kerja ini kehilangan centangnya. Selama itu, kompetisi berbayar baru tidak dapat diterbitkan dan peserta kompetisi berbayar yang sedang berjalan tidak dapat membayar.";
const WEBSITE_WARNING_BODY =
  "Mengganti situs web ruang kerja yang terverifikasi mencabut centangnya sampai lolos pemeriksaan lagi. Selama itu, kompetisi berbayar baru tidak dapat diterbitkan dan peserta kompetisi berbayar yang sedang berjalan tidak dapat membayar.";
const REMOVAL_UNCONFIRMED_SENTENCE = "Perubahan ini mencabut centang. Setujui peringatannya dulu.";
const INSTAGRAM_BIO_NOTE = "Perbarui juga tautan di bio Instagram Anda ke alamat baru.";

const removalUnconfirmed = () =>
  jsonResponse(409, { error: { code: "institution_tick_removal_unconfirmed", message: "x" } });

const renderShellWithTick = (tickPath: TickPath | null) =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <InstitutionSettingsShell
          institutionSlug="academy"
          expectedUserId="user-42"
          tickPath={tickPath}
        />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

// Answers each PATCH of the given url from the list in order, and every other request as the file's
// default answers do.
const stubPatchAnswers = (patchUrl: string, answers: Array<() => Response>) => {
  const remainingAnswers = [...answers];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH" && String(input) === patchUrl) {
      const answer = remainingAnswers.shift();
      if (!answer) throw new Error("unexpected extra PATCH");
      return answer();
    }
    if ((init?.method ?? "GET") === "GET" && String(input) === PROFILE_URL) {
      return jsonResponse(200, PROFILE);
    }
    return answerByUrlAndMethod(input, init);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
};

const patchRequestsOf = (stub: ReturnType<typeof vi.fn>) =>
  stub.mock.calls.filter(([, init]) => init?.method === "PATCH");

const changeNameAndPressSave = async () => {
  fireEvent.change(await screen.findByLabelText(NAME_LABEL), {
    target: { value: "Akademi Baru" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Simpan" }));
};

describe("the warning before a settings change removes the tick", () => {
  it("a rename that removes the tick asks first, then saves with the acknowledgement", async () => {
    const stub = stubPatchAnswers(SETTINGS_URL, [
      removalUnconfirmed,
      () => jsonResponse(200, institution("Akademi Baru")),
    ]);
    renderShellWithTick("domain");

    await changeNameAndPressSave();

    const dialog = await screen.findByRole("alertdialog", { name: WARNING_TITLE });
    expect(within(dialog).getByText(NAME_WARNING_BODY)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ganti nama dan cabut centang" }));

    expect(await screen.findByText("Pengaturan institusi berhasil disimpan.")).toBeTruthy();
    const patches = patchRequestsOf(stub);
    expect(patches).toHaveLength(2);
    expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({
      displayName: "Akademi Baru",
      slug: "academy",
    });
    expect(JSON.parse(String(patches[1]![1]!.body))).toEqual({
      displayName: "Akademi Baru",
      slug: "academy",
      acknowledgeTickRemoval: true,
    });
    expect(new Headers(patches[1]![1]!.headers).get("X-Expected-User-Id")).toBe("user-42");
  });

  it("Batal on the rename warning sends nothing more", async () => {
    const stub = stubPatchAnswers(SETTINGS_URL, [removalUnconfirmed]);
    renderShellWithTick("domain");

    await changeNameAndPressSave();
    const dialog = await screen.findByRole("alertdialog", { name: WARNING_TITLE });
    fireEvent.click(within(dialog).getByRole("button", { name: "Batal" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(patchRequestsOf(stub)).toHaveLength(1);
    expect(screen.queryByText("Pengaturan institusi berhasil disimpan.")).toBeNull();
  });

  it("a website change that removes the tick asks first, then saves with the acknowledgement", async () => {
    const stub = stubPatchAnswers(PROFILE_URL, [
      removalUnconfirmed,
      () => jsonResponse(200, PROFILE),
    ]);
    renderShellWithTick("domain");

    fireEvent.change(await screen.findByLabelText(WEBSITE_LABEL), {
      target: { value: "https://www.other.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan profil" }));

    const dialog = await screen.findByRole("alertdialog", { name: WARNING_TITLE });
    expect(within(dialog).getByText(WEBSITE_WARNING_BODY)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Simpan dan cabut centang" }));

    expect(await screen.findByText("Profil penyelenggara berhasil disimpan.")).toBeTruthy();
    const patches = patchRequestsOf(stub);
    expect(patches).toHaveLength(2);
    expect(JSON.parse(String(patches[1]![1]!.body))).toMatchObject({
      websiteUrl: "https://www.other.example",
      acknowledgeTickRemoval: true,
    });
  });

  it("a repeated acknowledgement refusal shows its sentence in the warning", async () => {
    stubPatchAnswers(SETTINGS_URL, [removalUnconfirmed, removalUnconfirmed]);
    renderShellWithTick("domain");

    await changeNameAndPressSave();
    const dialog = await screen.findByRole("alertdialog", { name: WARNING_TITLE });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ganti nama dan cabut centang" }));

    const dialogAfterRefusal = await screen.findByRole("alertdialog", { name: WARNING_TITLE });
    expect(await within(dialogAfterRefusal).findByText(REMOVAL_UNCONFIRMED_SENTENCE)).toBeTruthy();
  });

  it("a slug change of a workspace ticked by Instagram asks for the bio link", async () => {
    const instagramTicked = renderShellWithTick("instagram");

    const slugInput = await screen.findByLabelText(SLUG_LABEL);
    expect(screen.queryByText(INSTAGRAM_BIO_NOTE)).toBeNull();
    fireEvent.change(slugInput, { target: { value: "akademi-baru" } });
    expect(screen.getByText(INSTAGRAM_BIO_NOTE)).toBeTruthy();
    instagramTicked.unmount();

    renderShellWithTick("documents");
    fireEvent.change(await screen.findByLabelText(SLUG_LABEL), {
      target: { value: "akademi-baru" },
    });
    expect(screen.queryByText(INSTAGRAM_BIO_NOTE)).toBeNull();
  });
});
