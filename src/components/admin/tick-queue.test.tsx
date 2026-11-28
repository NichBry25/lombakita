// @vitest-environment jsdom

// The staff Centang queue, rendered inside the real UIPrimitivesProvider so the pop-ups and the
// toasts are the real ones. fetch is the only stub: the queue route, the detail route and the
// decision routes answer in the shapes their route tests pin.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { formatRupiah } from "@/lib/finance/payment-display";
import { VERIFICATION_REFUSAL_COPY } from "@/lib/institutions/verification-refusal-copy";
import { INSTITUTION_VERIFICATION_STATUS_LABELS } from "@/lib/institutions/verification-status-labels";
import {
  TickQueue,
  type TickNameCheckItem,
  type TickProofItem,
  type TickQueueItems,
  type TickRequestItem,
} from "./tick-queue";

const QUEUE_URL = "/api/platform-ops/tick-queue";
const NAME_CHECK_URL = "/api/platform-ops/institutions/inst_1/name-check";
const VERIFY_URL = "/api/admin/institutions/inst_1/verify";
const SUBMISSION_URL = "/api/platform-ops/verification/submissions/sub_1";

const NO_ONE_WAITING = "Tidak ada yang menunggu.";
const QUEUE_CLEAR_TITLE = "Antrean sudah bersih";

const TRUSTED_NOTE = "Jika disetujui, pengirim juga menjadi penyelenggara tepercaya.";
const NOT_TRUSTED_NOTE = "Persetujuan ini tidak membuat pengirim menjadi tepercaya.";
const SIBLING_STAFF = "Ruang kerja lain milik pemilik yang sama dicabut centangnya oleh staf.";
const SIBLING_AUTOMATIC =
  "Ruang kerja lain milik pemilik yang sama kehilangan centang secara otomatis.";
const NAME_OK_SENTENCE = "Centang tetap ada, dan kompetisi berbayar ruang kerja ini dapat tayang.";
const REQUIRE_PROOF_SENTENCE =
  "Pemilik punya 28 hari untuk mengirim bukti nama lewat dokumen. Jika tidak ada bukti, centang hilang pada hari ke-29.";
const REVOKE_SENTENCE =
  "Ruang kerja ini kehilangan centang dan hanya bisa mendapatkannya lagi lewat dokumen.";

const STAFF_CLOSURE_COPY =
  VERIFICATION_REFUSAL_COPY["institution_tick_closed_needs_documents:staff"];
const AUTOMATIC_CLOSURE_COPY =
  VERIFICATION_REFUSAL_COPY["institution_tick_closed_needs_documents:automatic"];

const requestFixture = (overrides: Partial<TickRequestItem> = {}): TickRequestItem => ({
  submissionId: "sub_1",
  institutionId: "inst_1",
  institutionSlug: "komunitas-ui",
  institutionDisplayName: "Komunitas UI",
  requestedPath: "instagram",
  instagramUrl: "https://www.instagram.com/komunitasui/",
  pageUrl: "https://lombakita.example/institution/komunitas-ui",
  submittedByUserId: "user_1",
  submitterEmail: "rina@acme.example",
  submitterWouldBeTrusted: true,
  submittedAt: "2026-11-20T03:00:00.000Z",
  overdue: false,
  documentCount: 0,
  closure: null,
  lastLeftVerified: null,
  siblingClosures: [],
  ...overrides,
});

const nameCheckFixture = (overrides: Partial<TickNameCheckItem> = {}): TickNameCheckItem => ({
  institutionId: "inst_1",
  institutionSlug: "komunitas-a",
  institutionDisplayName: "Komunitas A",
  tickDomain: "acme.example",
  ownerEmailDomains: ["acme.example"],
  paidDraft: {
    competitionId: "comp_1",
    title: "Lomba Esai Nasional",
    feeAmount: 50000,
    feeCurrency: "IDR",
  },
  since: "2026-11-18T03:00:00.000Z",
  siblingClosures: [],
  ...overrides,
});

const proofFixture = (overrides: Partial<TickProofItem> = {}): TickProofItem => ({
  institutionId: "inst_2",
  institutionSlug: "komunitas-b",
  institutionDisplayName: "Komunitas B",
  nameProofDueAt: "2026-12-10T03:00:00.000Z",
  reminded: false,
  ...overrides,
});

const queueOf = (parts: Partial<TickQueueItems> = {}): TickQueueItems => ({
  requests: [],
  nameChecks: [],
  runningProofs: [],
  ...parts,
});

type SentRequest = { url: string; method: string; body: unknown };

const sent: SentRequest[] = [];
let queue: TickQueueItems = queueOf();
let queueResponses: Array<() => Response> = [];
let answerRequest: (request: SentRequest) => Response | Promise<Response> = () => jsonResponse({});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const refusal = (code: string, status: number, details?: Record<string, unknown>) =>
  jsonResponse({ error: { code, message: "server text", details } }, status);

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const rawBody = typeof init?.body === "string" ? init.body : null;
  const request: SentRequest = {
    url,
    method: init?.method ?? "GET",
    body: rawBody === null ? null : JSON.parse(rawBody),
  };
  sent.push(request);
  if (url === QUEUE_URL) {
    const next = queueResponses.shift();
    return next ? next() : jsonResponse({ tickQueue: queue });
  }
  return answerRequest(request);
});

vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  queue = queueOf();
  queueResponses = [];
  answerRequest = () => jsonResponse({});
});

// jsdom does no layout, so it has no scrollIntoView, and focusFirstInvalidField scrolls the field into view.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const renderQueue = () =>
  render(
    <UIPrimitivesProvider>
      <TickQueue />
    </UIPrimitivesProvider>,
  );

const showQueue = async (items: TickQueueItems) => {
  queue = items;
  renderQueue();
  await screen.findByRole("heading", { level: 2, name: "Permintaan centang" });
};

const factOf = (label: string): string | null | undefined =>
  screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

const timeOf = (label: string): string | null | undefined =>
  screen
    .getByText(label, { selector: "dt" })
    .nextElementSibling?.querySelector("time")
    ?.getAttribute("datetime");

const toastOf = (text: string): Element | null =>
  screen.getByText(text).closest("[data-toast-type]");

const queueReads = (): SentRequest[] => sent.filter((request) => request.url === QUEUE_URL);

const decisionRequests = (): SentRequest[] => sent.filter((request) => request.url !== QUEUE_URL);

const requestsTo = (url: string, method: string): unknown[] =>
  sent.filter((request) => request.url === url && request.method === method).map((r) => r.body);

const sectionOf = (title: string): HTMLElement => {
  const section = screen.getByRole("heading", { level: 2, name: title }).closest("section");
  if (!section) throw new Error(`No section for ${title}`);
  return section;
};

const cardOf = (displayName: string): HTMLElement => {
  const card = screen.getByRole("heading", { level: 3, name: displayName }).closest("li");
  if (!card) throw new Error(`No card for ${displayName}`);
  return card;
};

const reasonFieldOf = (dialog: HTMLElement): HTMLTextAreaElement =>
  within(dialog).getByLabelText(/^Alasan/) as HTMLTextAreaElement;

const typeReason = (dialog: HTMLElement, reason: string) => {
  fireEvent.change(reasonFieldOf(dialog), { target: { value: reason } });
};

const openDialogFrom = (card: HTMLElement, buttonName: string): HTMLElement => {
  fireEvent.click(within(card).getByRole("button", { name: buttonName }));
  return screen.getByRole("dialog", { name: buttonName });
};

const pressMainAction = (dialog: HTMLElement, name: string) => {
  fireEvent.click(within(dialog).getByRole("button", { name }));
};

const waitForDialogToClose = async () => {
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
};

const failureOf = (dialog: HTMLElement): string | null | undefined =>
  dialog.querySelector(".modal-failure")?.textContent;

const expectFailure = async (dialog: HTMLElement, text: string) => {
  await waitFor(() => {
    expect(failureOf(dialog)).toBe(text);
  });
};

describe("what the queue shows", () => {
  it("shows a pending Instagram request with the address to find, the submitter and the badge", async () => {
    await showQueue(queueOf({ requests: [requestFixture()] }));
    const request = requestFixture();

    expect(screen.getByRole("heading", { level: 2, name: "Permintaan centang" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Komunitas UI" })).toBeTruthy();
    expect(screen.getByText("Menunggu").getAttribute("data-status")).toBe("awaiting");
    const sentence = `Cari tautan ${request.pageUrl} di bio ${request.instagramUrl}.`;
    expect(
      screen.getByText(
        (_content, element) => element?.tagName === "P" && element.textContent === sentence,
      ),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: request.instagramUrl ?? "" });
    expect(link.getAttribute("href")).toBe(request.instagramUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(factOf("Submitter")).toBe("rina@acme.example");
    expect(screen.getByText(TRUSTED_NOTE)).toBeTruthy();
    expect(screen.queryByText("Dokumen", { selector: "dt" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tinjau" })).toBeTruthy();
    for (const title of ["Pemeriksaan nama", "Bukti nama berjalan"]) {
      const section = within(sectionOf(title));
      expect(section.getByText(QUEUE_CLEAR_TITLE)).toBeTruthy();
      expect(section.getByText(NO_ONE_WAITING)).toBeTruthy();
    }
  });

  it("marks an old documents request Terlambat with its document count", async () => {
    await showQueue(
      queueOf({
        requests: [
          requestFixture({
            requestedPath: "documents",
            instagramUrl: null,
            overdue: true,
            documentCount: 2,
            submitterWouldBeTrusted: false,
          }),
        ],
      }),
    );

    expect(screen.getByText("Terlambat").getAttribute("data-status")).toBe("overdue");
    expect(screen.queryByText("Menunggu")).toBeNull();
    expect(factOf("Dokumen")).toBe("2");
    expect(screen.getByText(NOT_TRUSTED_NOTE)).toBeTruthy();
    expect(screen.queryByText(/^Cari tautan /)).toBeNull();
  });

  it("shows a closed workspace's cause, its last move out of verified and a closed sibling", async () => {
    const createdAt = "2026-11-21T03:00:00.000Z";
    await showQueue(
      queueOf({
        requests: [
          requestFixture({
            closure: { cause: "staff", closedInstitutionId: "inst_1" },
            lastLeftVerified: {
              toStatus: "rejected",
              reason: "Pengaduan dari institusi resmi.",
              actorUserId: "ops_1",
              createdAt,
            },
            siblingClosures: [{ cause: "automatic", closedInstitutionId: "inst_9" }],
          }),
        ],
      }),
    );

    expect(screen.getByText(STAFF_CLOSURE_COPY ?? "")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 4, name: "Terakhir kehilangan centang" }),
    ).toBeTruthy();
    expect(factOf("Ke")).toBe(INSTITUTION_VERIFICATION_STATUS_LABELS.rejected);
    expect(factOf("Alasan")).toBe("Pengaduan dari institusi resmi.");
    expect(factOf("Aktor")).toBe("ops_1");
    expect(timeOf("Waktu")).toBe(createdAt);
    expect(screen.getByText(SIBLING_AUTOMATIC)).toBeTruthy();
    expect(screen.queryByText(SIBLING_STAFF)).toBeNull();
  });

  it("shows a name check with the domains, the paid draft and since when", async () => {
    await showQueue(
      queueOf({
        nameChecks: [
          nameCheckFixture({
            ownerEmailDomains: ["acme.example", "students.acme.example"],
            siblingClosures: [{ cause: "staff", closedInstitutionId: "inst_9" }],
          }),
        ],
      }),
    );

    expect(screen.getByRole("heading", { level: 2, name: "Pemeriksaan nama" })).toBeTruthy();
    expect(factOf("Domain centang")).toBe("acme.example");
    expect(factOf("Domain Email organisasi pemilik")).toBe("acme.example, students.acme.example");
    expect(timeOf("Menunggu sejak")).toBe("2026-11-18T03:00:00.000Z");
    const draftSentence = `Kompetisi berbayar: Lomba Esai Nasional, ${formatRupiah(50000, "IDR")}.`;
    expect(
      screen.getByText(
        (_content, element) => element?.tagName === "P" && element.textContent === draftSentence,
      ),
    ).toBeTruthy();
    expect(screen.getByText(SIBLING_STAFF)).toBeTruthy();
    const buttons = within(cardOf("Komunitas A")).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Cabut centang",
      "Minta bukti nama",
      "Nama sesuai",
    ]);
  });

  it("shows a running proof with its due date and whether the reminder went", async () => {
    const reminded = proofFixture({ reminded: true });
    const silent = proofFixture({
      institutionId: "inst_3",
      institutionDisplayName: "Komunitas C",
      institutionSlug: "komunitas-c",
      nameProofDueAt: "2026-12-15T03:00:00.000Z",
    });
    await showQueue(queueOf({ runningProofs: [reminded, silent] }));

    expect(screen.getByRole("heading", { level: 2, name: "Bukti nama berjalan" })).toBeTruthy();
    for (const proof of [reminded, silent]) {
      const card = within(cardOf(proof.institutionDisplayName));
      const dueLine = card.getByText(
        (_content, element) =>
          element?.tagName === "P" && element.textContent?.startsWith("Batas bukti ") === true,
      );
      expect(dueLine.querySelector("time")?.getAttribute("datetime")).toBe(proof.nameProofDueAt);
      expect(card.getByRole("button", { name: "Cabut centang" })).toBeTruthy();
      expect(card.getByRole("button", { name: "Nama sesuai" })).toBeTruthy();
      expect(card.queryByRole("button", { name: "Minta bukti nama" })).toBeNull();
    }
    expect(screen.getAllByText("Pengingat terkirim")).toHaveLength(1);
    expect(within(cardOf("Komunitas B")).getByText("Pengingat terkirim")).toBeTruthy();
    expect(within(cardOf("Komunitas C")).queryByText("Pengingat terkirim")).toBeNull();
  });

  it("says the queue could not load, and loads it again on Muat ulang", async () => {
    queueResponses = [() => jsonResponse({ error: { code: "forbidden", message: "no" } }, 500)];
    renderQueue();

    expect(await screen.findByText("Antrean belum dapat dimuat")).toBeTruthy();
    expect(toastOf("Gagal memuat antrean verifikasi.")?.getAttribute("data-toast-type")).toBe(
      "error",
    );

    fireEvent.click(screen.getByRole("button", { name: "Muat ulang" }));

    await waitFor(() => {
      expect(screen.getAllByText(QUEUE_CLEAR_TITLE)).toHaveLength(3);
    });
    expect(queueReads()).toHaveLength(2);
  });
});

describe("the name decisions and the revocation", () => {
  it("sends Nama sesuai on a name check with or without a reason", async () => {
    await showQueue(queueOf({ nameChecks: [nameCheckFixture()] }));
    answerRequest = () => jsonResponse({ nameCheck: {} });

    const blankDialog = openDialogFrom(cardOf("Komunitas A"), "Nama sesuai");
    expect(within(blankDialog).getByText(NAME_OK_SENTENCE)).toBeTruthy();
    pressMainAction(blankDialog, "Nama sesuai");

    await waitFor(() => {
      expect(requestsTo(NAME_CHECK_URL, "POST")).toEqual([{ decision: "name_ok" }]);
    });
    await waitFor(() => {
      expect(toastOf("Nama ditandai sesuai.")?.getAttribute("data-toast-type")).toBe("success");
    });
    await waitForDialogToClose();
    await waitFor(() => {
      expect(queueReads()).toHaveLength(2);
    });

    await screen.findByRole("heading", { level: 3, name: "Komunitas A" });
    const reasonDialog = openDialogFrom(cardOf("Komunitas A"), "Nama sesuai");
    typeReason(reasonDialog, "  Nama sudah sesuai.  ");
    pressMainAction(reasonDialog, "Nama sesuai");

    await waitFor(() => {
      expect(requestsTo(NAME_CHECK_URL, "POST")).toEqual([
        { decision: "name_ok" },
        { decision: "name_ok", reason: "Nama sudah sesuai." },
      ]);
    });
    await waitFor(() => {
      expect(queueReads()).toHaveLength(3);
    });
  });

  it("asks for a reason before Nama sesuai on a running proof, Minta bukti nama or Cabut centang", async () => {
    await showQueue(queueOf({ nameChecks: [nameCheckFixture()], runningProofs: [proofFixture()] }));
    const attempts = [
      { card: "Komunitas B", action: "Nama sesuai" },
      { card: "Komunitas A", action: "Minta bukti nama" },
      { card: "Komunitas A", action: "Cabut centang" },
    ];

    for (const { card, action } of attempts) {
      const dialog = openDialogFrom(cardOf(card), action);
      typeReason(dialog, "   ");
      pressMainAction(dialog, action);

      expect(await within(dialog).findByText("Alasan wajib diisi.")).toBeTruthy();
      const field = reasonFieldOf(dialog);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      await waitFor(() => {
        expect(document.activeElement).toBe(field);
      });
      expect(decisionRequests()).toEqual([]);

      fireEvent.click(within(dialog).getByRole("button", { name: "Batal" }));
      await waitForDialogToClose();
    }
  });

  it("sends Minta bukti nama and Cabut centang with the trimmed reason", async () => {
    await showQueue(queueOf({ nameChecks: [nameCheckFixture()] }));
    answerRequest = () => jsonResponse({});

    const proofDialog = openDialogFrom(cardOf("Komunitas A"), "Minta bukti nama");
    expect(within(proofDialog).getByText(REQUIRE_PROOF_SENTENCE)).toBeTruthy();
    typeReason(proofDialog, " Mohon kirim akta. ");
    pressMainAction(proofDialog, "Minta bukti nama");

    await waitFor(() => {
      expect(requestsTo(NAME_CHECK_URL, "POST")).toEqual([
        { decision: "require_proof", reason: "Mohon kirim akta." },
      ]);
    });
    await waitFor(() => {
      expect(
        toastOf("Bukti nama diminta. Batasnya 28 hari dari sekarang.")?.getAttribute(
          "data-toast-type",
        ),
      ).toBe("success");
    });
    await waitForDialogToClose();
    await screen.findByRole("heading", { level: 3, name: "Komunitas A" });

    const revokeDialog = openDialogFrom(cardOf("Komunitas A"), "Cabut centang");
    expect(within(revokeDialog).getByText(REVOKE_SENTENCE)).toBeTruthy();
    typeReason(revokeDialog, " Pengaduan. ");
    pressMainAction(revokeDialog, "Cabut centang");

    await waitFor(() => {
      expect(requestsTo(VERIFY_URL, "PATCH")).toEqual([
        { targetStatus: "rejected", reason: "Pengaduan." },
      ]);
    });
    await waitFor(() => {
      expect(toastOf("Centang dicabut.")?.getAttribute("data-toast-type")).toBe("success");
    });
  });
});

describe("the review of a request", () => {
  const detailOf = (documents: { id: string; originalFileName: string }[]) => ({
    submission: {
      id: "sub_1",
      institutionSlug: "komunitas-ui",
      institutionDisplayName: "Komunitas UI",
      targetInstitutionType: "campus_organization",
      proposedDisplayName: null,
      status: "pending_review",
      emailDomainFlag: null,
      reviewerNotes: null,
      submittedAt: "2026-11-20T03:00:00.000Z",
      documents: documents.map((document) => ({
        ...document,
        documentType: "akta",
        r2Key: `key/${document.id}`,
        fileSizeBytes: 1024,
        contentType: "application/pdf",
      })),
    },
  });

  const openReview = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByRole("button", { name: "Tinjau" }));
    return screen.findByRole("dialog", { name: "Tinjau pengajuan" });
  };

  const answerReview = (
    documents: { id: string; originalFileName: string }[],
    decision: Response,
  ) => {
    answerRequest = (request) =>
      request.method === "GET" ? jsonResponse(detailOf(documents)) : decision.clone();
  };

  it("opens the review of a request and sends the decision with the notes", async () => {
    await showQueue(queueOf({ requests: [requestFixture({ requestedPath: "documents" })] }));
    answerReview(
      [{ id: "doc_1", originalFileName: "akta.pdf" }],
      jsonResponse({ trustedSubmitter: true }),
    );

    const approveDialog = await openReview();
    expect(requestsTo(SUBMISSION_URL, "GET")).toEqual([null]);
    expect(within(approveDialog).getByText("akta.pdf")).toBeTruthy();
    fireEvent.click(within(approveDialog).getByRole("button", { name: "Setujui" }));

    await waitFor(() => {
      expect(requestsTo(SUBMISSION_URL, "PATCH")).toEqual([
        { decision: "approved", reviewerNotes: null },
      ]);
    });
    const trustedMessage =
      "Disetujui. Ruang kerja ini kini mendapat centang dan pengirimnya tepercaya.";
    await waitFor(() => {
      expect(toastOf(trustedMessage)?.getAttribute("data-toast-type")).toBe("success");
    });
    await waitForDialogToClose();

    const rejectDialog = await openReview();
    fireEvent.change(within(rejectDialog).getByLabelText(/^Catatan reviewer/), {
      target: { value: " Dokumen kurang jelas. " },
    });
    fireEvent.click(within(rejectDialog).getByRole("button", { name: "Tolak" }));

    await waitFor(() => {
      expect(requestsTo(SUBMISSION_URL, "PATCH")).toEqual([
        { decision: "approved", reviewerNotes: null },
        { decision: "rejected", reviewerNotes: "Dokumen kurang jelas." },
      ]);
    });
    await waitFor(() => {
      expect(
        toastOf("Permintaan ditolak dan keluar dari antrean.")?.getAttribute("data-toast-type"),
      ).toBe("success");
    });
    await waitForDialogToClose();

    answerReview(
      [{ id: "doc_1", originalFileName: "akta.pdf" }],
      jsonResponse({ trustedSubmitter: false }),
    );
    const untrustedDialog = await openReview();
    fireEvent.click(within(untrustedDialog).getByRole("button", { name: "Setujui" }));
    await waitFor(() => {
      expect(
        toastOf("Disetujui. Ruang kerja ini kini mendapat centang.")?.getAttribute(
          "data-toast-type",
        ),
      ).toBe("success");
    });
    await waitForDialogToClose();

    answerReview([], jsonResponse({ trustedSubmitter: false }));
    const instagramDialog = await openReview();
    expect(within(instagramDialog).queryByText("Dokumen")).toBeNull();
  });
});

describe("every refusal of the decision routes", () => {
  it("shows every refusal of the decision routes in Indonesian", async () => {
    await showQueue(
      queueOf({
        requests: [
          requestFixture({ institutionId: "inst_7", institutionDisplayName: "Komunitas UI" }),
        ],
        nameChecks: [nameCheckFixture()],
        runningProofs: [proofFixture()],
      }),
    );
    const copy = (code: string): string => VERIFICATION_REFUSAL_COPY[code] ?? "";

    // Nama sesuai on a name check, reason left blank.
    const nameOkDialog = openDialogFrom(cardOf("Komunitas A"), "Nama sesuai");
    const nameOkAnswers: [Response, string][] = [
      [
        refusal("institution_name_check_reason_required", 422),
        copy("institution_name_check_reason_required"),
      ],
      [
        refusal("institution_name_check_not_applicable", 409),
        "Ruang kerja ini tidak lagi perlu diperiksa namanya. Muat ulang halaman untuk melihat antrean terbaru.",
      ],
      [refusal("unknown_code", 500), "Nama gagal ditandai sesuai. Coba lagi."],
    ];
    for (const [answer, text] of nameOkAnswers) {
      answerRequest = () => answer.clone();
      pressMainAction(nameOkDialog, "Nama sesuai");
      await expectFailure(nameOkDialog, text);
    }
    answerRequest = () => {
      throw new Error("offline");
    };
    pressMainAction(nameOkDialog, "Nama sesuai");
    await expectFailure(nameOkDialog, NETWORK_ERROR_MESSAGE);
    fireEvent.click(within(nameOkDialog).getByRole("button", { name: "Batal" }));
    await waitForDialogToClose();

    // Minta bukti nama.
    const proofDialog = openDialogFrom(cardOf("Komunitas A"), "Minta bukti nama");
    typeReason(proofDialog, "Mohon kirim akta.");
    const proofAnswers: [Response, string][] = [
      [
        refusal("institution_name_proof_running", 409),
        "Bukti nama ruang kerja ini sudah berjalan. Muat ulang halaman untuk melihat antrean terbaru.",
      ],
      [
        refusal("institution_name_check_reason_invalid", 400),
        "Isi alasan, paling banyak 1000 karakter.",
      ],
      [refusal("operator_actor_conflicted", 403), copy("operator_actor_conflicted")],
      [refusal("verification_transition_conflict", 409), copy("verification_transition_conflict")],
      [refusal("unknown_code", 500), "Bukti nama gagal diminta. Coba lagi."],
    ];
    for (const [answer, text] of proofAnswers) {
      answerRequest = () => answer.clone();
      pressMainAction(proofDialog, "Minta bukti nama");
      await expectFailure(proofDialog, text);
    }
    answerRequest = () => {
      throw new Error("offline");
    };
    pressMainAction(proofDialog, "Minta bukti nama");
    await expectFailure(proofDialog, NETWORK_ERROR_MESSAGE);
    fireEvent.click(within(proofDialog).getByRole("button", { name: "Batal" }));
    await waitForDialogToClose();

    // Cabut centang.
    const revokeDialog = openDialogFrom(cardOf("Komunitas A"), "Cabut centang");
    typeReason(revokeDialog, "Pengaduan.");
    const revokeAnswers: [Response, string][] = [
      [refusal("verification_reason_required", 400), "Alasan wajib diisi."],
      [refusal("unknown_code", 500), "Centang gagal dicabut. Coba lagi."],
    ];
    for (const [answer, text] of revokeAnswers) {
      answerRequest = () => answer.clone();
      pressMainAction(revokeDialog, "Cabut centang");
      await expectFailure(revokeDialog, text);
    }
    answerRequest = () => {
      throw new Error("offline");
    };
    pressMainAction(revokeDialog, "Cabut centang");
    await expectFailure(revokeDialog, NETWORK_ERROR_MESSAGE);
    fireEvent.click(within(revokeDialog).getByRole("button", { name: "Batal" }));
    await waitForDialogToClose();

    // The review approval answers its refusals in a toast and keeps the pop-up open.
    const reviewAnswers: [Response, string][] = [
      [
        refusal("institution_tick_closed_needs_documents", 409, { cause: "staff" }),
        STAFF_CLOSURE_COPY ?? "",
      ],
      [
        refusal("institution_tick_closed_needs_documents", 409, { cause: "automatic" }),
        AUTOMATIC_CLOSURE_COPY ?? "",
      ],
      [
        refusal("institution_name_proof_needs_documents", 409),
        copy("institution_name_proof_needs_documents"),
      ],
      [
        refusal("institution_tick_live_paid_competition", 409),
        copy("institution_tick_live_paid_competition"),
      ],
    ];
    for (const [answer, text] of reviewAnswers) {
      answerRequest = (request) =>
        request.method === "GET"
          ? jsonResponse({
              submission: {
                id: "sub_1",
                institutionSlug: "komunitas-ui",
                institutionDisplayName: "Komunitas UI",
                targetInstitutionType: "campus_organization",
                proposedDisplayName: null,
                status: "pending_review",
                emailDomainFlag: null,
                reviewerNotes: null,
                submittedAt: "2026-11-20T03:00:00.000Z",
                documents: [],
              },
            })
          : answer.clone();
      fireEvent.click(screen.getByRole("button", { name: "Tinjau" }));
      const reviewDialog = await screen.findByRole("dialog", { name: "Tinjau pengajuan" });
      fireEvent.click(within(reviewDialog).getByRole("button", { name: "Setujui" }));
      await waitFor(() => {
        expect(toastOf(text)?.getAttribute("data-toast-type")).toBe("error");
      });
      fireEvent.click(within(reviewDialog).getByRole("button", { name: "Batal" }));
      await waitForDialogToClose();
    }

    expect(queueReads()).toHaveLength(1);
  });
});
