// @vitest-environment jsdom

// The staff host check queue, rendered inside the real UIPrimitivesProvider so the pop-ups and the
// toasts are the real ones. fetch is the only stub: the queue route and the decision route answer
// in the shapes their route tests pin.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { formatRupiah } from "@/lib/finance/payment-display";
import { HostCheckQueue, type HostCheckQueueItem } from "./host-check-queue";

const QUEUE_URL = "/api/platform-ops/host-checks";
const CHECK_URL = "/api/platform-ops/host-checks/check_1";
const KONTAK_TEXT = "Penyelenggara mencantumkan kontak yang benar-benar bisa dihubungi peserta.";

const itemFixture = (overrides: Partial<HostCheckQueueItem> = {}): HostCheckQueueItem => ({
  id: "check_1",
  submittedAt: "2026-11-20T03:00:00.000Z",
  overdue: false,
  host: {
    userId: "user_host",
    fullName: "Rina Pratama",
    mobileNumber: "0812345678",
    email: "rina@acme.example",
    trustRemovedAt: null,
    trustRemovalReason: null,
  },
  draft: {
    competitionId: "comp_1",
    title: "Lomba Esai Nasional",
    description: "Deskripsi kompetisi untuk pengujian.",
    category: "essay",
    mode: "individual",
    location: "online",
    registrationStartAt: "2026-12-01T03:00:00.000Z",
    registrationEndAt: "2026-12-10T03:00:00.000Z",
    eventStartAt: "2026-12-12T03:00:00.000Z",
    eventEndAt: "2026-12-13T03:00:00.000Z",
    resultAnnouncementAt: "2026-12-20T03:00:00.000Z",
    feeAmount: null,
    feeCurrency: null,
    organizerContactKind: "whatsapp",
    organizerContactValue: "6281234567890",
    institutionName: "Universitas Contoh",
  },
  earlierTurnDowns: [],
  ...overrides,
});

type SentRequest = { url: string; method: string; body: unknown };

const sent: SentRequest[] = [];
let queueItems: HostCheckQueueItem[] = [];
let queueResponses: Array<() => Response | Promise<Response>> = [];
let decisionResponse: () => Response = () => jsonResponse({});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const rawBody = typeof init?.body === "string" ? init.body : null;
  sent.push({
    url,
    method: init?.method ?? "GET",
    body: rawBody === null ? null : JSON.parse(rawBody),
  });
  if (url === QUEUE_URL) {
    const next = queueResponses.shift();
    return next ? next() : jsonResponse({ hostChecks: queueItems });
  }
  return decisionResponse();
});

vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  queueItems = [];
  queueResponses = [];
  decisionResponse = () => jsonResponse({});
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
      <HostCheckQueue />
    </UIPrimitivesProvider>,
  );

const showQueue = async (items: HostCheckQueueItem[]) => {
  queueItems = items;
  renderQueue();
  await screen.findByRole("heading", { name: items[0]?.draft.title ?? "" });
};

const factOf = (label: string): string | null | undefined =>
  screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

const toastOf = (text: string): Element | null =>
  screen.getByText(text).closest("[data-toast-type]");

const postsTo = (url: string): SentRequest[] =>
  sent.filter((request) => request.url === url && request.method === "POST");

const queueReads = (): SentRequest[] => sent.filter((request) => request.url === QUEUE_URL);

const answered = (status: "approved" | "rejected", published: boolean) => () =>
  jsonResponse({ hostCheck: { id: "check_1", userId: "user_host", status, published } });

const openTurnDownDialog = (): HTMLElement => {
  fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
  return screen.getByRole("dialog");
};

const pickGuideline = (dialog: HTMLElement) => {
  fireEvent.click(
    within(dialog).getByRole("combobox", { name: "Pedoman yang tidak dipenuhi (wajib)" }),
  );
  fireEvent.click(within(dialog).getByRole("option", { name: KONTAK_TEXT }));
};

const typeNote = (dialog: HTMLElement, note: string) => {
  fireEvent.change(
    within(dialog).getByLabelText(/^Catatan untuk penyelenggara(?: \* \(wajib\)| \(opsional\))?$/),
    { target: { value: note } },
  );
};

describe("what the queue shows", () => {
  it("shows each open check with the person, the draft and a Menunggu badge", async () => {
    await showQueue([itemFixture()]);

    expect(screen.getByText("Universitas Contoh")).toBeTruthy();
    expect(screen.getByText("Menunggu").getAttribute("data-status")).toBe("awaiting");
    expect(factOf("Nama")).toBe("Rina Pratama");
    expect(factOf("Nomor ponsel")).toBe("0812345678");
    expect(factOf("Email akun")).toBe("rina@acme.example");
    expect(factOf("Kategori")).toBe("Esai");
    expect(factOf("Mode")).toBe("Individu");
    expect(factOf("Lokasi")).toBe("Online");
    expect(factOf("Biaya")).toBe("Gratis");
    expect(factOf("Kontak penyelenggara")).toBe("WhatsApp 6281234567890");
    expect(screen.getByText("Deskripsi kompetisi untuk pengujian.")).toBeTruthy();
    expect(screen.queryByText("Penolakan sebelumnya")).toBeNull();
  });

  it("marks a check sent more than 7 days ago Terlambat", async () => {
    await showQueue([itemFixture({ overdue: true })]);

    expect(screen.getByText("Terlambat").getAttribute("data-status")).toBe("overdue");
    expect(screen.queryByText("Menunggu")).toBeNull();
  });

  it("says Belum diisi for a field the host left empty and shows the fee of a paid draft", async () => {
    await showQueue([
      itemFixture({
        draft: {
          ...itemFixture().draft,
          category: null,
          resultAnnouncementAt: null,
          organizerContactKind: null,
          organizerContactValue: null,
          feeAmount: 50000,
          feeCurrency: "IDR",
        },
      }),
    ]);

    expect(factOf("Kategori")).toBe("Belum diisi");
    expect(factOf("Pengumuman hasil")).toBe("Belum diisi");
    expect(factOf("Kontak penyelenggara")).toBe("Belum diisi");
    expect(factOf("Biaya")).toBe(formatRupiah(50000, "IDR"));
  });

  it("lists the earlier turn-downs with the date, the guideline text and the note", async () => {
    await showQueue([
      itemFixture({
        earlierTurnDowns: [
          {
            reviewedAt: "2026-11-10T03:00:00.000Z",
            guidelineItem: "kontak-nyata",
            note: "Nomor kontak tidak aktif.",
          },
        ],
      }),
    ]);

    expect(screen.getByRole("heading", { name: "Penolakan sebelumnya" })).toBeTruthy();
    const line = screen.getByText(/Penyelenggara mencantumkan kontak/).closest("li");
    expect(line?.textContent).toMatch(/^Ditolak /);
    expect(line?.textContent).toContain(`: ${KONTAK_TEXT} Nomor kontak tidak aktif.`);
    expect(line?.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-10T03:00:00.000Z");
  });

  it("warns that staff removed the host's trust, gives the reason, and says an approval restores it", async () => {
    await showQueue([
      itemFixture({
        host: {
          ...itemFixture().host,
          trustRemovedAt: "2026-11-15T03:00:00.000Z",
          trustRemovalReason: "Kontak palsu.",
        },
      }),
    ]);

    const note = screen.getByText(/Status tepercaya akun ini dicabut staf pada/);
    expect(note.textContent).toContain(
      "Menyetujui pemeriksaan ini membuat akun ini tepercaya lagi.",
    );
    expect(note.closest(".feedback")?.getAttribute("data-tone")).toBe("warning");
    expect(screen.getByText("Alasan pencabutan: Kontak palsu.").closest(".feedback")).toBe(
      note.closest(".feedback"),
    );
  });

  it("says the queue is clear when no check waits", async () => {
    renderQueue();

    expect(await screen.findByText("Antrean sudah bersih")).toBeTruthy();
    expect(screen.getByText("Tidak ada kompetisi yang menunggu pemeriksaan.")).toBeTruthy();
  });

  it("says the queue could not load, and loads it again on Muat ulang", async () => {
    queueItems = [itemFixture()];
    queueResponses = [() => jsonResponse({ error: { code: "forbidden", message: "no" } }, 403)];
    renderQueue();

    expect(await screen.findByText("Antrean belum dapat dimuat")).toBeTruthy();
    expect(toastOf("Gagal memuat antrean pemeriksaan.")?.getAttribute("data-toast-type")).toBe(
      "error",
    );

    fireEvent.click(screen.getByRole("button", { name: "Muat ulang" }));

    expect(await screen.findByRole("heading", { name: "Lomba Esai Nasional" })).toBeTruthy();
    expect(queueReads()).toHaveLength(2);
  });
});

describe("approving a host check", () => {
  it("names the consequence, sends the approval and reports a published draft", async () => {
    await showQueue([itemFixture()]);
    decisionResponse = answered("approved", true);

    fireEvent.click(screen.getByRole("button", { name: "Setujui dan tayangkan" }));

    expect(
      screen.getByText("Akun ini menjadi tepercaya dan draf Lomba Esai Nasional langsung tayang."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    const message = "Disetujui. Akun ini kini tepercaya dan kompetisinya sudah tayang.";
    await waitFor(() => {
      expect(screen.getByText(message)).toBeTruthy();
    });
    expect(toastOf(message)?.getAttribute("data-toast-type")).toBe("success");
    expect(postsTo(CHECK_URL).map((request) => request.body)).toEqual([{ decision: "approve" }]);
    await waitFor(() => {
      expect(queueReads()).toHaveLength(2);
    });
  });

  it("reports an approval whose draft could not go live", async () => {
    await showQueue([itemFixture()]);
    decisionResponse = answered("approved", false);

    fireEvent.click(screen.getByRole("button", { name: "Setujui dan tayangkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Disetujui. Akun ini kini tepercaya, tetapi kompetisinya belum dapat tayang. Penyelenggara diminta menerbitkannya sendiri.",
        ),
      ).toBeTruthy();
    });
  });

  it("reports an approval of a check whose draft was deleted as a closed check", async () => {
    await showQueue([itemFixture()]);
    decisionResponse = answered("rejected", false);

    fireEvent.click(screen.getByRole("button", { name: "Setujui dan tayangkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Draf ini sudah tidak tersedia, jadi pemeriksaan ditutup tanpa persetujuan.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("turning a host check down", () => {
  it("sends the guideline item and the trimmed note", async () => {
    await showQueue([itemFixture()]);
    decisionResponse = answered("rejected", false);

    const dialog = openTurnDownDialog();
    pickGuideline(dialog);
    typeNote(dialog, "  Nomor kontak tidak aktif.  ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    await waitFor(() => {
      expect(screen.getByText("Pemeriksaan ditolak dan keluar dari antrean.")).toBeTruthy();
    });
    expect(postsTo(CHECK_URL).map((request) => request.body)).toEqual([
      { decision: "turn_down", guidelineItem: "kontak-nyata", note: "Nomor kontak tidak aktif." },
    ]);
  });

  it("sends nothing and names the field when no guideline item is picked", async () => {
    await showQueue([itemFixture()]);

    const dialog = openTurnDownDialog();
    typeNote(dialog, "Nomor kontak tidak aktif.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    expect(await within(dialog).findByText("Pilih pedoman yang tidak dipenuhi.")).toBeTruthy();
    expect(postsTo(CHECK_URL)).toEqual([]);
  });

  it("sends nothing and names the field when the note is blank", async () => {
    await showQueue([itemFixture()]);

    const dialog = openTurnDownDialog();
    pickGuideline(dialog);
    typeNote(dialog, "   ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    expect(await within(dialog).findByText("Isi catatan untuk penyelenggara.")).toBeTruthy();
    expect(postsTo(CHECK_URL)).toEqual([]);
  });
});

// One row per code the decision route answers with. The server's message is never the sentence the
// operator reads.
const DECISION_REFUSALS: { code: string; status: number; message: string; copy: string }[] = [
  {
    code: "host_check_not_found",
    status: 404,
    message: "Host check not found",
    copy: "Pemeriksaan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  },
  {
    code: "host_check_already_decided",
    status: 409,
    message: "This host check already has a staff decision",
    copy: "Pemeriksaan ini sudah diputuskan. Muat ulang halaman untuk melihat antrean terbaru.",
  },
  {
    code: "host_check_target_not_host",
    status: 422,
    message: "The account does not hold the host role and cannot be trusted",
    copy: "Akun ini tidak memegang peran penyelenggara, jadi tidak dapat disetujui. Tolak pemeriksaan ini untuk menutupnya.",
  },
  {
    code: "account_deactivated",
    status: 409,
    message: "Account is deactivated",
    copy: "Data akun ini sudah dihapus. Tindakan ini tidak tersedia.",
  },
  {
    code: "operator_actor_is_target",
    status: 403,
    message: "A platform-ops account cannot decide its own host check",
    copy: "Anda tidak dapat memeriksa kompetisi akun Anda sendiri.",
  },
  {
    code: "operator_actor_not_platform_ops",
    status: 403,
    message: "actor is not platform_ops",
    copy: "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  },
  {
    code: "forbidden",
    status: 403,
    message: "no",
    copy: "Anda tidak punya akses untuk tindakan ini.",
  },
  {
    code: "invalid_payload",
    status: 400,
    message: "decision must be 'approve' or 'turn_down'",
    copy: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  },
  {
    code: "operator_actor_not_found",
    status: 403,
    message: "The acting account was not found",
    copy: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  },
  {
    code: "operator_actor_suspended",
    status: 403,
    message: "The acting account is suspended and cannot perform platform-ops actions",
    copy: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  },
];

describe("what the queue tells the operator when the decision route refuses", () => {
  it.each(DECISION_REFUSALS)(
    "shows the $code refusal in the operator's words",
    async ({ code, status, message, copy }) => {
      await showQueue([itemFixture()]);
      decisionResponse = () => jsonResponse({ error: { code, message } }, status);

      fireEvent.click(screen.getByRole("button", { name: "Setujui dan tayangkan" }));
      fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

      await waitFor(() => {
        expect(within(screen.getByRole("alertdialog")).getByRole("alert").textContent).toContain(
          copy,
        );
      });
      expect(screen.queryByText(message)).toBeNull();
    },
  );
});

const GUIDELINE_TRIGGER_NAME = "Pedoman yang tidak dipenuhi (wajib)";
const NOTE_LABEL = /^Catatan untuk penyelenggara(?: \* \(wajib\)| \(opsional\))?$/;

describe("the turn-down pop-up", () => {
  it("keeps the turn-down pop-up and the typed note when Escape closes the guideline list", async () => {
    await showQueue([itemFixture()]);
    const dialog = openTurnDownDialog();
    typeNote(dialog, "Nomor kontak tidak aktif.");
    fireEvent.click(within(dialog).getByRole("combobox", { name: GUIDELINE_TRIGGER_NAME }));

    fireEvent.keyDown(within(dialog).getByRole("option", { name: KONTAK_TEXT }), {
      key: "Escape",
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((within(dialog).getByLabelText(NOTE_LABEL) as HTMLTextAreaElement).value).toBe(
      "Nomor kontak tidak aktif.",
    );

    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: GUIDELINE_TRIGGER_NAME }), {
      key: "Escape",
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the guideline list invalid and points it at its error when no item is picked", async () => {
    await showQueue([itemFixture()]);
    const dialog = openTurnDownDialog();
    typeNote(dialog, "Nomor kontak tidak aktif.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    await within(dialog).findByText("Pilih pedoman yang tidak dipenuhi.");
    const trigger = within(dialog).getByRole("combobox", { name: GUIDELINE_TRIGGER_NAME });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")).toBe("host-check-guideline-error");
    expect(document.getElementById("host-check-guideline-error")?.textContent).toContain(
      "Pilih pedoman yang tidak dipenuhi.",
    );
  });

  it("names the draft and the host in the turn-down pop-up", async () => {
    await showQueue([itemFixture()]);

    const dialog = openTurnDownDialog();

    expect(
      within(dialog).getByText(
        "Draf Lomba Esai Nasional dari Rina Pratama tidak tayang. Penyelenggara membaca pedoman dan catatan ini.",
      ),
    ).toBeTruthy();
  });

  const TURN_DOWN_REFUSALS = [
    { code: "host_check_guideline_required", copy: "Pilih pedoman yang tidak dipenuhi." },
    {
      code: "host_check_guideline_unknown",
      copy: "Pedoman itu tidak ada dalam daftar. Muat ulang halaman lalu pilih lagi.",
    },
    {
      code: "host_check_note_required",
      copy: "Isi catatan untuk penyelenggara, paling banyak 1000 karakter.",
    },
  ];

  it.each(TURN_DOWN_REFUSALS)(
    "keeps the turn-down form, its guideline and its note when the decision route refuses with $code",
    async ({ code, copy }) => {
      await showQueue([itemFixture()]);
      decisionResponse = () => jsonResponse({ error: { code, message: "raw server text" } }, 400);
      const dialog = openTurnDownDialog();
      pickGuideline(dialog);
      typeNote(dialog, "Nomor kontak tidak aktif.");

      fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

      await waitFor(() => {
        expect(within(dialog).getByRole("alert").textContent).toContain(copy);
      });
      expect(
        within(dialog).getByRole("combobox", {
          name: `Pedoman yang tidak dipenuhi: ${KONTAK_TEXT} (wajib)`,
        }),
      ).toBeTruthy();
      expect((within(dialog).getByLabelText(NOTE_LABEL) as HTMLTextAreaElement).value).toBe(
        "Nomor kontak tidak aktif.",
      );
      expect(screen.queryByText("raw server text")).toBeNull();
    },
  );

  it("says the connection failed inside the turn-down pop-up", async () => {
    await showQueue([itemFixture()]);
    decisionResponse = () => {
      throw new TypeError("network down");
    };
    const dialog = openTurnDownDialog();
    pickGuideline(dialog);
    typeNote(dialog, "Nomor kontak tidak aktif.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert").textContent).toContain(NETWORK_ERROR_MESSAGE);
    });
  });

  it("moves focus to the guideline list when Tolak finds no guideline picked", async () => {
    await showQueue([itemFixture()]);
    const dialog = openTurnDownDialog();
    typeNote(dialog, "Nomor kontak tidak aktif.");
    act(() => {
      within(dialog).getByLabelText(NOTE_LABEL).focus();
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(dialog).getByRole("combobox", { name: GUIDELINE_TRIGGER_NAME }),
      );
    });
  });

  it("moves focus to the note when Tolak finds the note blank", async () => {
    await showQueue([itemFixture()]);
    const dialog = openTurnDownDialog();
    pickGuideline(dialog);
    typeNote(dialog, "   ");

    fireEvent.click(within(dialog).getByRole("button", { name: "Tolak" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByLabelText(NOTE_LABEL));
    });
  });

  it("names the guideline list as a combobox that controls the list it opens", async () => {
    await showQueue([itemFixture()]);
    const dialog = openTurnDownDialog();
    const trigger = within(dialog).getByRole("combobox", { name: GUIDELINE_TRIGGER_NAME });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(within(dialog).getByRole("listbox").id);
  });
});

describe("the approval pop-up and the loading queue", () => {
  it("opens the approval as an alert pop-up with focus on Batal", async () => {
    await showQueue([itemFixture()]);

    fireEvent.click(screen.getByRole("button", { name: "Setujui dan tayangkan" }));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Batal"));
  });

  it("marks the loading queue as waiting", () => {
    queueResponses = [() => new Promise<Response>(() => {})];

    renderQueue();

    const loading = screen.getByRole("status", { name: "Memuat pemeriksaan penyelenggara" });
    expect(loading.getAttribute("aria-busy")).toBe("true");
  });
});
