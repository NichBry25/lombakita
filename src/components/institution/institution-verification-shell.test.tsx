// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { formatDateIn } from "@/lib/dates/date-format";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import type { TickPageState } from "@/server/institution-verification/tick-service";
import { InstitutionVerificationShell } from "./institution-verification-shell";

type ShellProps = ComponentProps<typeof InstitutionVerificationShell>;

const { mockPush, mockRefresh, mockSessionFetch } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockSessionFetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

// Only sessionFetch is replaced: readErrorCode and the session-mismatch code and sentence stay real,
// because error-copy.ts reads the last two when it is imported.
vi.mock("@/lib/session/session-fetch", async () => ({
  ...(await vi.importActual("@/lib/session/session-fetch")),
  sessionFetch: mockSessionFetch,
}));

const MATCHING_TICK_STATE: TickPageState = {
  workspaceClosure: null,
  otherWorkspaceClosure: null,
  hasPublishedPaidCompetition: false,
  organizationEmailDomain: "students.acme.example",
  websiteHost: "acme.example",
  domainsMatch: true,
};

const BASE_PROPS: ShellProps = {
  institutionSlug: "institusi-contoh",
  expectedUserId: "user-1",
  institutionId: "inst-1",
  institutionType: "university",
  displayName: "Institusi Contoh",
  pageUrl: "http://localhost:3000/institution/institusi-contoh",
  isVerified: false,
  rejectionReason: null,
  tickPath: null,
  nameChecked: false,
  nameProofDueAt: null,
  tickState: MATCHING_TICK_STATE,
};

const mount = (overrides: Partial<ShellProps> = {}) =>
  render(
    <UIPrimitivesProvider>
      <InstitutionVerificationShell {...BASE_PROPS} {...overrides} />
    </UIPrimitivesProvider>,
  );

const tickStateWith = (change: Partial<TickPageState>): TickPageState => ({
  ...MATCHING_TICK_STATE,
  ...change,
});

const attachDocumentAndSubmit = async () => {
  const input = await screen.findByLabelText(/^SK pendirian(?: \* \(wajib\)| \(opsional\))?$/);
  const file = new File(["%PDF-1.4"], "sk-pendirian.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Kirim dokumen" }));
};

describe("InstitutionVerificationShell submit", () => {
  beforeEach(() => {
    // The history GET is a plain fetch; a fresh Response per call, because a body is read once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ submissions: [] }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the pending sentence and refreshes the page when a submission is already pending", async () => {
    mockSessionFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "verification_submission_already_pending" } }), {
        status: 409,
      }),
    );
    mount();

    await attachDocumentAndSubmit();

    expect(
      await screen.findByText("Pengajuan verifikasi untuk institusi ini masih menunggu tinjauan."),
    ).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockSessionFetch).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback sentence when the refusal body is not JSON", async () => {
    mockSessionFetch.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    mount();

    await attachDocumentAndSubmit();

    expect(await screen.findByText("Pengajuan gagal dikirim. Coba lagi.")).toBeTruthy();
  });

  it("shows the connection sentence when the request itself fails", async () => {
    mockSessionFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    mount();

    await attachDocumentAndSubmit();

    expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeTruthy();
    expect(screen.getByRole("alertdialog", { name: "Pengajuan gagal" })).toBeTruthy();
  });
});

const PAGE_LEAD =
  "Centang menunjukkan bahwa ruang kerja ini benar milik organisasinya. Kompetisi gratis tetap bisa tayang tanpa centang. Kompetisi berbayar membutuhkan centang.";
const EMAIL_ORGANISATION_TEXT =
  "Cocok bila domain email organisasi Anda sama dengan domain situs web ruang kerja ini.";
const MATCHING_STATE_LINE =
  "Email organisasi Anda: students.acme.example. Situs web: acme.example.";
const NO_ORGANIZATION_EMAIL_LINE = "Konfirmasi email organisasi Anda dulu di Dasbor penyelenggara.";
const NO_WEBSITE_LINE = "Isi situs web resmi di pengaturan profil ruang kerja.";
const INSTAGRAM_HINT =
  "Pasang tautan http://localhost:3000/institution/institusi-contoh di bio Instagram resmi Anda, atau di halaman tautan seperti Linktree atau lynk.id yang ada di bio. Tautan ke beranda Lombakita tidak dihitung.";
const PENDING_REQUEST_LINE =
  "Permintaan Anda sedang diperiksa staf. Perkiraan 1x24 jam pada hari kerja.";
const NAME_CHECK_PENDING_LINE =
  "Nama ruang kerja diperiksa staf sebelum kompetisi berbayar pertama tayang. Perkiraan 1x24 jam pada hari kerja.";
const DOMAIN_TICKED_TOAST = "Domain cocok. Ruang kerja ini kini mendapat centang.";
const INSTAGRAM_SENT_TOAST =
  "Tautan terkirim. Staf akan memeriksanya dalam 1x24 jam pada hari kerja.";
const STAFF_HISTORY_SENTENCE =
  "Institusi ini diverifikasi langsung oleh tim platform, tanpa pengajuan dokumen.";
const EMPTY_HISTORY_SENTENCE = "Riwayat peninjauan dokumen institusi akan muncul di sini.";

const REFUSAL_NO_ORGANIZATION_EMAIL = "Konfirmasi email organisasi Anda dulu.";
const REFUSAL_NO_WEBSITE = "Isi situs web resmi ruang kerja dulu.";
const REFUSAL_DOMAIN_MISMATCH =
  "Domain email organisasi Anda tidak sama dengan domain situs web ruang kerja ini.";
const REFUSAL_OWNER_TRUST_REMOVED =
  "Status tepercaya akun Anda dicabut staf, jadi centang tidak dapat didapat lewat email organisasi.";
const REFUSAL_LIVE_PAID =
  "Ruang kerja ini punya kompetisi berbayar yang sedang tayang, jadi centang hanya bisa didapat lagi lewat dokumen agar staf memeriksa namanya.";
const REFUSAL_NAME_PROOF_NEEDS_DOCUMENTS =
  "Selama bukti nama berjalan, nama ruang kerja hanya dapat dibuktikan lewat dokumen. Kirim dokumen sebelum batas waktunya.";
const REFUSAL_INSTAGRAM_INVALID =
  "Tautan belum benar. Contoh: https://www.instagram.com/namaorganisasi";
const REFUSAL_NOT_APPLICABLE =
  "Ruang kerja pribadi mendapat centang lewat email organisasi atau Instagram.";

const CLOSURE_LINES = [
  "Centang ruang kerja ini dicabut atau ditolak staf, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "Centang ruang kerja ini hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "Centang ruang kerja lain milik Anda dicabut atau ditolak staf, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "Centang ruang kerja lain milik Anda hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "Centang ruang kerja ini dicabut atau ditolak staf. Hubungi staf Lombakita lewat halaman kontak untuk memulihkannya.",
  "Centang ruang kerja ini hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu. Hubungi staf Lombakita lewat halaman kontak untuk memulihkannya.",
  "Centang ruang kerja lain milik Anda dicabut atau ditolak staf. Hubungi staf Lombakita lewat halaman kontak untuk memulihkannya.",
  "Centang ruang kerja lain milik Anda hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu. Hubungi staf Lombakita lewat halaman kontak untuk memulihkannya.",
] as const;

const INSTAGRAM_LABEL = /^Tautan profil Instagram(?: \* \(wajib\)| \(opsional\))?$/;
const SUBMIT_PATH = "/api/v1/institutions/institusi-contoh/verification/submit";
const DOMAIN_PATH = "/api/v1/institutions/institusi-contoh/tick/domain";
const HISTORY_PATH = "/api/v1/institutions/institusi-contoh/verification/submissions";

const PENDING_SUBMISSION = {
  id: "sub-1",
  targetInstitutionType: "university",
  proposedDisplayName: null,
  status: "pending_review",
  submittedAt: "2026-11-01T00:00:00.000Z",
  reviewedAt: null,
  reviewerNotes: null,
  documentCount: 0,
};

const stubHistory = (submissions: unknown[] = []) => {
  const historyStub = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify({ submissions })));
  vi.stubGlobal("fetch", historyStub);
  return historyStub;
};

const jsonAnswer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const waitForPathCards = () => screen.findByRole("heading", { name: "Dokumen" });

const openFailureDialog = () => screen.findByRole("alertdialog", { name: "Pengajuan gagal" });

describe("the owner tick page", () => {
  beforeEach(() => {
    stubHistory();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("an unticked workspace shows the heading, the lead and the three path cards", async () => {
    mount();

    expect(screen.getByRole("heading", { name: "Centang terverifikasi" })).toBeTruthy();
    expect(screen.getByText(PAGE_LEAD)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Email organisasi" })).toBeTruthy();
    expect(await waitForPathCards()).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Instagram resmi" })).toBeTruthy();
    expect(screen.getByText(EMAIL_ORGANISATION_TEXT)).toBeTruthy();
    expect(screen.getByText(MATCHING_STATE_LINE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cocokkan domain" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kirim untuk diperiksa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kirim dokumen" })).toBeTruthy();
    expect(screen.getByLabelText(INSTAGRAM_LABEL)).toBeTruthy();
    expect(screen.getByText(INSTAGRAM_HINT)).toBeTruthy();
  });

  it("the Email organisasi card shows what blocks it, in the order the domain route refuses", async () => {
    const blockedCases: Array<{ tickState: TickPageState; shows: string[]; hides?: string[] }> = [
      { tickState: tickStateWith({ workspaceClosure: "staff" }), shows: [CLOSURE_LINES[0]] },
      {
        tickState: tickStateWith({ workspaceClosure: "staff", organizationEmailDomain: null }),
        shows: [CLOSURE_LINES[0]],
        hides: [NO_ORGANIZATION_EMAIL_LINE],
      },
      {
        tickState: tickStateWith({ otherWorkspaceClosure: "automatic" }),
        shows: [CLOSURE_LINES[3]],
      },
      {
        tickState: tickStateWith({ hasPublishedPaidCompetition: true }),
        shows: [REFUSAL_LIVE_PAID],
      },
      {
        tickState: tickStateWith({ organizationEmailDomain: null }),
        shows: [NO_ORGANIZATION_EMAIL_LINE],
      },
      { tickState: tickStateWith({ websiteHost: null }), shows: [NO_WEBSITE_LINE] },
      {
        tickState: tickStateWith({ websiteHost: "other.example", domainsMatch: false }),
        shows: [
          "Email organisasi Anda: students.acme.example. Situs web: other.example.",
          REFUSAL_DOMAIN_MISMATCH,
        ],
      },
    ];

    for (const blockedCase of blockedCases) {
      const view = mount({ tickState: blockedCase.tickState });
      await waitForPathCards();

      for (const sentence of blockedCase.shows) {
        expect(screen.getAllByText(sentence).length).toBeGreaterThan(0);
      }
      for (const sentence of blockedCase.hides ?? []) {
        expect(screen.queryByText(sentence)).toBeNull();
      }
      expect(screen.queryByRole("button", { name: "Cocokkan domain" })).toBeNull();
      view.unmount();
    }
  });

  it("a closure line names its cause, its workspace and the workspace kind", async () => {
    const closureCases = [
      { institutionType: "university", key: "workspaceClosure", cause: "staff", line: 0 },
      { institutionType: "university", key: "workspaceClosure", cause: "automatic", line: 1 },
      { institutionType: "university", key: "otherWorkspaceClosure", cause: "staff", line: 2 },
      { institutionType: "university", key: "otherWorkspaceClosure", cause: "automatic", line: 3 },
      { institutionType: "personal", key: "workspaceClosure", cause: "staff", line: 4 },
      { institutionType: "personal", key: "workspaceClosure", cause: "automatic", line: 5 },
      { institutionType: "personal", key: "otherWorkspaceClosure", cause: "staff", line: 6 },
      { institutionType: "personal", key: "otherWorkspaceClosure", cause: "automatic", line: 7 },
    ] as const;

    for (const closureCase of closureCases) {
      const view = mount({
        institutionType: closureCase.institutionType,
        tickState: tickStateWith({ [closureCase.key]: closureCase.cause }),
      });
      await waitForPathCards();

      const line = CLOSURE_LINES[closureCase.line];
      if (closureCase.key === "workspaceClosure") {
        expect(screen.getAllByText(line)).toHaveLength(2);
        expect(screen.queryByRole("button", { name: "Kirim untuk diperiksa" })).toBeNull();
      } else {
        expect(screen.getAllByText(line)).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Kirim untuk diperiksa" })).toBeTruthy();
      }
      view.unmount();
    }
  });

  it("pressing Cocokkan domain sends the Path A request for the expected user and reloads the page", async () => {
    mockSessionFetch.mockResolvedValue(
      jsonAnswer(200, {
        institution: { id: "inst-1", verificationStatus: "verified", tickPath: "domain" },
      }),
    );
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Cocokkan domain" }));

    expect(await screen.findByText(DOMAIN_TICKED_TOAST)).toBeTruthy();
    expect(mockSessionFetch).toHaveBeenCalledTimes(1);
    expect(mockSessionFetch).toHaveBeenCalledWith("user-1", DOMAIN_PATH, { method: "POST" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("a refused Path A press shows its sentence", async () => {
    const closedOn = (cause: string, closedInstitutionId: string) => ({
      error: {
        code: "institution_tick_path_a_closed",
        details: { cause, closedInstitutionId },
      },
    });
    const refusalCases: Array<{
      answer: () => Promise<Response>;
      sentence: string;
      refreshes: number;
    }> = [
      {
        answer: async () =>
          jsonAnswer(422, { error: { code: "institution_tick_no_organization_email" } }),
        sentence: REFUSAL_NO_ORGANIZATION_EMAIL,
        refreshes: 1,
      },
      {
        answer: async () => jsonAnswer(422, { error: { code: "institution_tick_no_website" } }),
        sentence: REFUSAL_NO_WEBSITE,
        refreshes: 1,
      },
      {
        answer: async () =>
          jsonAnswer(422, { error: { code: "institution_tick_domain_mismatch" } }),
        sentence: REFUSAL_DOMAIN_MISMATCH,
        refreshes: 1,
      },
      {
        answer: async () =>
          jsonAnswer(403, { error: { code: "institution_tick_owner_trust_removed" } }),
        sentence: REFUSAL_OWNER_TRUST_REMOVED,
        refreshes: 0,
      },
      {
        answer: async () =>
          jsonAnswer(409, { error: { code: "institution_tick_live_paid_competition" } }),
        sentence: REFUSAL_LIVE_PAID,
        refreshes: 1,
      },
      {
        answer: async () => jsonAnswer(409, closedOn("staff", "inst-1")),
        sentence: CLOSURE_LINES[0],
        refreshes: 1,
      },
      {
        answer: async () => jsonAnswer(409, closedOn("automatic", "inst-2")),
        sentence: CLOSURE_LINES[3],
        refreshes: 1,
      },
      {
        answer: async () => new Response("Internal Server Error", { status: 500 }),
        sentence: "Pengajuan gagal dikirim. Coba lagi.",
        refreshes: 0,
      },
      {
        answer: async () => {
          throw new TypeError("Failed to fetch");
        },
        sentence: NETWORK_ERROR_MESSAGE,
        refreshes: 0,
      },
    ];

    for (const refusalCase of refusalCases) {
      mockRefresh.mockClear();
      mockSessionFetch.mockImplementation(refusalCase.answer);
      const view = mount();

      fireEvent.click(await screen.findByRole("button", { name: "Cocokkan domain" }));

      const dialog = await openFailureDialog();
      expect(within(dialog).getByText(refusalCase.sentence)).toBeTruthy();
      expect(mockRefresh).toHaveBeenCalledTimes(refusalCase.refreshes);
      view.unmount();
    }
  });

  it("sending the Instagram link sends an instagram request for the expected user", async () => {
    mockSessionFetch.mockResolvedValue(jsonAnswer(201, { submissionId: "sub-1", documents: [] }));
    const historyStub = stubHistory();
    mount();

    fireEvent.change(await screen.findByLabelText(INSTAGRAM_LABEL), {
      target: { value: "https://instagram.com/acme.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim untuk diperiksa" }));

    expect(await screen.findByText(INSTAGRAM_SENT_TOAST)).toBeTruthy();
    expect(mockSessionFetch).toHaveBeenCalledTimes(1);
    const [userId, url, init] = mockSessionFetch.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(url).toBe(SUBMIT_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      path: "instagram",
      instagramUrl: "https://instagram.com/acme.org",
    });
    await waitFor(() => expect(historyStub).toHaveBeenCalledTimes(2));
    expect(historyStub.mock.calls.map(([historyUrl]) => historyUrl)).toEqual([
      HISTORY_PATH,
      HISTORY_PATH,
    ]);
  });

  it("a refused Instagram link shows its sentence", async () => {
    const refusalCases: Array<{ status: number; body: unknown; sentence: string }> = [
      {
        status: 400,
        body: { error: { code: "institution_tick_instagram_invalid" } },
        sentence: REFUSAL_INSTAGRAM_INVALID,
      },
      {
        status: 409,
        body: {
          error: {
            code: "institution_tick_closed_needs_documents",
            details: { cause: "staff", closedInstitutionId: "inst-1" },
          },
        },
        sentence: CLOSURE_LINES[0],
      },
      {
        status: 409,
        body: { error: { code: "institution_name_proof_needs_documents" } },
        sentence: REFUSAL_NAME_PROOF_NEEDS_DOCUMENTS,
      },
    ];

    for (const refusalCase of refusalCases) {
      mockSessionFetch.mockResolvedValue(jsonAnswer(refusalCase.status, refusalCase.body));
      const view = mount();

      fireEvent.change(await screen.findByLabelText(INSTAGRAM_LABEL), {
        target: { value: "https://instagram.com/acme.org" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Kirim untuk diperiksa" }));

      const dialog = await openFailureDialog();
      expect(within(dialog).getByText(refusalCase.sentence)).toBeTruthy();
      view.unmount();
    }
  });

  it("a ticked workspace says how it won the tick", async () => {
    const tickedLines = {
      domain: "Ruang kerja ini terverifikasi lewat email organisasi.",
      instagram: "Ruang kerja ini terverifikasi lewat Instagram.",
      documents: "Ruang kerja ini terverifikasi lewat dokumen.",
      staff: "Ruang kerja ini terverifikasi lewat keputusan staf.",
    } as const;

    for (const tickPath of ["domain", "instagram", "documents", "staff"] as const) {
      const view = mount({ isVerified: true, tickPath });

      expect(screen.getByText(tickedLines[tickPath])).toBeTruthy();
      if (tickPath === "domain") {
        await waitForPathCards();
        expect(screen.getByRole("heading", { name: "Instagram resmi" })).toBeTruthy();
      } else {
        await screen.findByText("Belum ada pengajuan");
        expect(screen.queryByRole("heading", { name: "Instagram resmi" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Dokumen" })).toBeNull();
      }
      expect(screen.queryByRole("heading", { name: "Email organisasi" })).toBeNull();
      view.unmount();
    }
  });

  it("a Path A tick shows the name check, or the running proof with its date", async () => {
    const pendingView = mount({ isVerified: true, tickPath: "domain" });
    await waitForPathCards();
    expect(screen.getByText(NAME_CHECK_PENDING_LINE)).toBeTruthy();
    pendingView.unmount();

    const checkedView = mount({ isVerified: true, tickPath: "domain", nameChecked: true });
    await waitForPathCards();
    expect(screen.queryByText(NAME_CHECK_PENDING_LINE)).toBeNull();
    checkedView.unmount();

    mount({
      isVerified: true,
      tickPath: "domain",
      nameProofDueAt: "2026-12-31T00:00:00.000Z",
    });
    await waitForPathCards();
    const dueDate = formatDateIn(new Date("2026-12-31T00:00:00.000Z"), "longDate", undefined);
    const proofLine = `Staf meminta bukti bahwa ruang kerja ini berhak memakai nama Institusi Contoh. Kirim dokumen sebagai bukti sebelum ${dueDate}. Tanpa bukti, centang dicabut otomatis.`;
    expect(
      screen.getByText(
        (_, element) => element?.tagName === "P" && element.textContent === proofLine,
      ),
    ).toBeTruthy();
    expect(screen.getByText(REFUSAL_NAME_PROOF_NEEDS_DOCUMENTS)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kirim untuk diperiksa" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kirim dokumen" })).toBeTruthy();
  });

  it("a pending request shows the staff check line and holds the Instagram and document forms", async () => {
    stubHistory([PENDING_SUBMISSION]);
    mount();

    expect(await screen.findByText(PENDING_REQUEST_LINE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kirim untuk diperiksa" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kirim dokumen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cocokkan domain" })).toBeTruthy();
  });

  it("a personal workspace sends no documents", async () => {
    mount({ institutionType: "personal" });

    expect(await screen.findByText(REFUSAL_NOT_APPLICABLE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kirim dokumen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kirim untuk diperiksa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cocokkan domain" })).toBeTruthy();
  });

  it("the empty history names the platform team only for a staff tick", async () => {
    const staffView = mount({ isVerified: true, tickPath: "staff" });
    expect(await screen.findByText(STAFF_HISTORY_SENTENCE)).toBeTruthy();
    staffView.unmount();

    mount({ isVerified: true, tickPath: "domain" });
    expect(await screen.findByText(EMPTY_HISTORY_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(STAFF_HISTORY_SENTENCE)).toBeNull();
  });
});
