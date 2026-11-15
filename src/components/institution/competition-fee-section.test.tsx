// @vitest-environment jsdom
//
// The CLIENT half of the disclosure gate, which the browser assertions structurally cannot see:
// `ui-states` reads rendered text, so a fee that saves without an acknowledgement looks the same on
// screen as one that refuses. Weakening the acknowledgement check left every browser case green.
//
// The server gate is the enforcement and is proven against a real database. What is asserted here
// is that the organiser is never invited to consent to a disclosure that is not on the screen.

import { beforeEach, describe, expect, it, vi } from "vitest";
// `fireEvent` rather than user-event: the latter is not a dependency of this project and a
// checkbox click plus a text change do not need its extra fidelity.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { formatRupiah } from "@/lib/finance/payment-display";
import { CompetitionFeeSection } from "./competition-fee-section";
import {
  CompetitionEditorPartsContext,
  type CompetitionEditorPart,
  type CompetitionPartSaveResult,
  type ReportCompetitionEditorPart,
} from "./competition-editor-parts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const RULE = {
  basisPoints: 250,
  flatAmount: 0,
  currency: "IDR",
  minimumFeeAmount: null,
  maximumFeeAmount: null,
};

const reportPart = vi.fn<ReportCompetitionEditorPart>();

beforeEach(() => {
  reportPart.mockClear();
});

const mountWith = async (body: unknown, viewerIsOwner = true) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => body } as Response),
  );

  render(
    <UIPrimitivesProvider>
      <CompetitionEditorPartsContext.Provider value={reportPart}>
        <CompetitionFeeSection
          competitionId="comp_1"
          expectedUserId="org_1"
          viewerIsOwner={viewerIsOwner}
        />
      </CompetitionEditorPartsContext.Provider>
    </UIPrimitivesProvider>,
  );

  // The section loads its own state, so nothing is asserted until the skeleton is gone.
  return screen.findByRole("heading", { name: "Biaya pendaftaran" });
};

const mountRefused = async (code: string, status: number, viewerIsOwner = true) => {
  // A real Response: the section reads the code through readErrorCode, which reads a clone.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status })),
  );

  render(
    <UIPrimitivesProvider>
      <CompetitionEditorPartsContext.Provider value={reportPart}>
        <CompetitionFeeSection
          competitionId="comp_1"
          expectedUserId="org_1"
          viewerIsOwner={viewerIsOwner}
        />
      </CompetitionEditorPartsContext.Provider>
    </UIPrimitivesProvider>,
  );

  // The refused state renders the same heading as the loaded form.
  return screen.findByRole("heading", { name: "Biaya pendaftaran" });
};

const OWNER_ONLY_MESSAGE = "Hanya pemilik institusi yang dapat mengatur biaya pendaftaran.";

const LOAD_FAILURE_MESSAGE = "Biaya pendaftaran gagal dimuat. Muat ulang halaman lalu coba lagi.";

const DISCLOSURE_REASON =
  "Setujui rincian biaya layanan Lombakita sebelum mengaktifkan pendaftaran berbayar.";

const NO_RULE_REASON =
  "Tarif layanan Lombakita belum dikonfigurasi, sehingga pendaftaran berbayar belum dapat diaktifkan. Hubungi tim Lombakita.";

const PAID = {
  pricing: { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 },
  feeRule: RULE,
};

const FREE = {
  pricing: { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 },
  feeRule: RULE,
};

const PRICE_REASON = "Biaya pendaftaran tidak dapat diubah setelah kompetisi terbit.";
const LOCKED_PAID = { ...PAID, priceLocked: true };
const LOCKED_FREE = { ...FREE, priceLocked: true };

const feeReports = () => reportPart.mock.calls.filter(([key]) => key === "fee");

const lastReportedFeePart = (): CompetitionEditorPart => {
  const reports = feeReports();
  const part = reports[reports.length - 1]?.[1];
  if (!part) throw new Error("the fee section reported no part");
  return part;
};

const saveReportedFee = async (): Promise<CompetitionPartSaveResult | undefined> => {
  let result: CompetitionPartSaveResult | undefined;
  await act(async () => {
    result = await lastReportedFeePart().save();
  });
  return result;
};

const putCalls = () =>
  vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PUT");

const patchCalls = () =>
  vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PATCH");

const acknowledgement = () => screen.getByRole("checkbox", { name: /menyetujui/ });

describe("CompetitionFeeSection", () => {
  it("shows what the platform takes, computed from the amount on screen", async () => {
    // 250 bps on Rp 150.000 is Rp 3.750, leaving Rp 146.250. Asserted as figures because a
    // disclosure showing the wrong number is worse than one showing none.
    await mountWith({
      pricing: { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 },
      feeRule: RULE,
    });

    // Read straight off the elements rather than through a text matcher. `formatRupiah` emits a
    // NON-BREAKING space (codepoint 160), and Testing Library normalizes an element's text while
    // comparing it against the matcher string as given, so a matcher with an ordinary space and
    // one with the NBSP both miss, for opposite reasons. The figures are this test's subject; the
    // matcher's normalization rules are not.
    const amounts = [...document.querySelectorAll("dd.data-text")].map((el) =>
      (el.textContent ?? "").replace(/\u00a0/g, " "),
    );

    // 250 bps on Rp 150.000 is Rp 3.750, leaving Rp 146.250.
    expect(amounts).toEqual(["Rp 150.000", "Rp 3.750", "Rp 146.250"]);
  });

  it("WITHHOLDS save until the organiser acknowledges", async () => {
    await mountWith(PAID);

    expect(await saveReportedFee()).toEqual({ ok: false, errorMessage: DISCLOSURE_REASON });
    expect(putCalls()).toEqual([]);
  });

  it("saves a paid fee once the organiser acknowledges", async () => {
    await mountWith(PAID);

    fireEvent.click(acknowledgement());

    expect(await saveReportedFee()).toEqual({ ok: true });
    const [put] = putCalls();
    const init = put?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      feeAmount: 150_000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
      feeDisclosureAcknowledged: true,
    });
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe("org_1");
  });

  it("REVOKES the acknowledgement when the amount changes", async () => {
    // Consent does not survive a change to what is being consented to. Without this, an organiser
    // could agree to the fee on Rp 10.000 and save a price of Rp 10.000.000.
    await mountWith(PAID);

    fireEvent.click(acknowledgement());
    fireEvent.change(screen.getByLabelText("Biaya per pendaftaran"), {
      target: { value: "1500000" },
    });

    expect(await saveReportedFee()).toEqual({ ok: false, errorMessage: DISCLOSURE_REASON });
    expect(putCalls()).toEqual([]);
  });

  it("cannot be acknowledged while no rate is configured", async () => {
    // A missing fee rule is a real state and the server fails closed on it. The organiser is told
    // why rather than being allowed to agree to terms that do not exist.
    await mountWith({
      pricing: { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 },
      feeRule: null,
    });

    expect(screen.getByText(/Tarif layanan Lombakita belum dikonfigurasi/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /menyetujui/ })).toBeNull();
    expect(await saveReportedFee()).toEqual({ ok: false, errorMessage: NO_RULE_REASON });
    expect(putCalls()).toEqual([]);
  });

  it("WITHHOLDS the whole disclosure on a free competition", async () => {
    await mountWith({
      pricing: { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 },
      feeRule: RULE,
    });

    expect(screen.queryByText("Rincian per pendaftaran")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /menyetujui/ })).toBeNull();
    // Save stays available: clearing a fee needs no acknowledgement, and the server agrees.
    expect(await saveReportedFee()).toEqual({ ok: true });
    const [put] = putCalls();
    expect(JSON.parse((put?.[1] as RequestInit).body as string)).toMatchObject({ feeAmount: 0 });
  });

  it("has no save button of its own and reports its unsaved changes", async () => {
    await mountWith(PAID);

    expect(screen.queryByRole("button", { name: /Simpan biaya pendaftaran/ })).toBeNull();
    expect(lastReportedFeePart().isDirty).toBe(false);

    fireEvent.change(screen.getByLabelText("Batas waktu pembayaran (hari)"), {
      target: { value: "5" },
    });
    expect(lastReportedFeePart().isDirty).toBe(true);

    fireEvent.click(acknowledgement());
    expect(await saveReportedFee()).toEqual({ ok: true });
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("sends the full free body when a paid fee is switched off, and then reports no change", async () => {
    await mountWith(PAID);

    fireEvent.click(screen.getByRole("checkbox", { name: "Pendaftaran berbayar" }));
    expect(lastReportedFeePart().isDirty).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PUT"
          ? ({ ok: true, json: async () => ({}) } as Response)
          : ({
              ok: true,
              json: async () => ({
                pricing: { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 },
                feeRule: RULE,
              }),
            } as Response),
      ),
    );

    expect(await saveReportedFee()).toEqual({ ok: true });
    const [put] = putCalls();
    expect(JSON.parse((put?.[1] as RequestInit).body as string)).toEqual({
      feeAmount: 0,
      feeCurrency: null,
      paymentWindowDays: 3,
      feeDisclosureAcknowledged: false,
    });
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("counts an unsent consent tick as a change and sends it once", async () => {
    await mountWith(PAID);

    fireEvent.click(acknowledgement());
    expect(lastReportedFeePart().isDirty).toBe(true);

    expect(await saveReportedFee()).toEqual({ ok: true });
    const [put] = putCalls();
    expect(JSON.parse((put?.[1] as RequestInit).body as string)).toEqual({
      feeAmount: 150000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
      feeDisclosureAcknowledged: true,
    });
    expect(lastReportedFeePart().isDirty).toBe(false);

    fireEvent.click(acknowledgement());
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("keeps an unsent consent tick unsent when its save is refused", async () => {
    await mountWith(PAID);

    fireEvent.click(acknowledgement());
    expect(lastReportedFeePart().isDirty).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "competition_fee_disclosure_required" } }), {
          status: 422,
        }),
      ),
    );

    const result = await saveReportedFee();

    expect(lastReportedFeePart().isDirty).toBe(true);
    expect(putCalls()).toHaveLength(1);
    expect(result).toEqual({ ok: false, errorMessage: DISCLOSURE_REASON });
  });

  it("reports a saved fee as saved when the reload body cannot be read", async () => {
    await mountWith(PAID);

    fireEvent.change(screen.getByLabelText("Batas waktu pembayaran (hari)"), {
      target: { value: "5" },
    });
    fireEvent.click(acknowledgement());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PUT"
          ? ({ ok: true, json: async () => ({}) } as Response)
          : new Response("not json", { status: 200 }),
      ),
    );

    expect(await saveReportedFee()).toEqual({ ok: true });
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("returns the connection reason when the save request throws", async () => {
    await mountWith({
      pricing: { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 },
      feeRule: RULE,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    expect(await saveReportedFee()).toEqual({
      ok: false,
      errorMessage: "Biaya pendaftaran gagal disimpan karena gangguan koneksi.",
    });
  });

  it("tells a staff member that only the owner sets a fee that is off", async () => {
    await mountWith(FREE, false);

    expect(screen.getByRole("status").textContent).toBe(OWNER_ONLY_MESSAGE);
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("shows a staff member the amount read-only and the window editable", async () => {
    await mountWith(PAID, false);

    const amount = document.querySelector("p.data-text");
    expect(amount?.textContent).toBe(formatRupiah(150_000, "IDR"));
    expect(amount?.previousElementSibling?.textContent).toBe("Biaya per pendaftaran");
    expect((screen.getByLabelText("Batas waktu pembayaran (hari)") as HTMLInputElement).value).toBe(
      "3",
    );
    expect(screen.queryByRole("checkbox", { name: "Pendaftaran berbayar" })).toBeNull();
    expect(screen.queryByLabelText("Biaya per pendaftaran")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /menyetujui/ })).toBeNull();
    expect(
      screen.getByText(
        "Hanya pemilik institusi yang dapat mengubah biaya atau menonaktifkan pendaftaran berbayar.",
      ),
    ).toBeTruthy();
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("sends only the window for a staff member and then reports no change", async () => {
    await mountWith(PAID, false);

    fireEvent.change(screen.getByLabelText("Batas waktu pembayaran (hari)"), {
      target: { value: "5" },
    });
    expect(lastReportedFeePart().isDirty).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PATCH"
          ? ({ ok: true, json: async () => ({ ok: true }) } as Response)
          : ({
              ok: true,
              json: async () => ({
                pricing: { ...PAID.pricing, paymentWindowDays: 5 },
                feeRule: RULE,
              }),
            } as Response),
      ),
    );

    expect(await saveReportedFee()).toEqual({ ok: true });
    expect(patchCalls()).toHaveLength(1);
    const init = patchCalls()[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ paymentWindowDays: 5 });
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe("org_1");
    expect(putCalls()).toEqual([]);
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("names a fee that is no longer on when a staff save is refused", async () => {
    await mountWith(PAID, false);

    fireEvent.change(screen.getByLabelText("Batas waktu pembayaran (hari)"), {
      target: { value: "5" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "competition_fee_not_enabled" } }), {
          status: 409,
        }),
      ),
    );

    expect(await saveReportedFee()).toEqual({
      ok: false,
      errorMessage:
        "Biaya pendaftaran belum aktif. Hanya pemilik institusi yang dapat mengaktifkannya.",
    });
    expect(lastReportedFeePart().isDirty).toBe(true);
  });

  it("reports the fee part to the editor for the owner", async () => {
    await mountWith(PAID);

    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("tells an owner whose load is refused that only the owner sets the fee", async () => {
    await mountRefused("forbidden", 403);

    expect(screen.getByRole("status").textContent).toBe(OWNER_ONLY_MESSAGE);
  });

  it("shows the load failure as an error for any other refused load", async () => {
    await mountRefused("competition_not_found", 404);

    expect(screen.getByRole("alert").textContent).toBe(LOAD_FAILURE_MESSAGE);
  });

  it("shows the owner of a published competition the price read-only and the window editable, with the reason", async () => {
    await mountWith(LOCKED_PAID);

    expect({
      amount: document.querySelector("p.data-text")?.textContent,
      windowDays: (screen.getByLabelText("Batas waktu pembayaran (hari)") as HTMLInputElement)
        .value,
      paidToggle: screen.queryByRole("checkbox", { name: "Pendaftaran berbayar" }),
      consent: screen.queryByRole("checkbox", { name: /menyetujui/ }),
      reason: screen.getByRole("status").textContent,
      isDirty: lastReportedFeePart().isDirty,
    }).toEqual({
      amount: formatRupiah(150_000, "IDR"),
      windowDays: "3",
      paidToggle: null,
      consent: null,
      reason: PRICE_REASON,
      isDirty: false,
    });
  });

  it("moves only the window for the owner of a published competition and then reports no change", async () => {
    await mountWith(LOCKED_PAID);

    fireEvent.change(screen.getByLabelText("Batas waktu pembayaran (hari)"), {
      target: { value: "5" },
    });
    expect(lastReportedFeePart().isDirty).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PATCH"
          ? ({ ok: true, json: async () => ({ ok: true }) } as Response)
          : ({
              ok: true,
              json: async () => ({
                pricing: { ...PAID.pricing, paymentWindowDays: 5 },
                feeRule: RULE,
                priceLocked: true,
              }),
            } as Response),
      ),
    );

    expect(await saveReportedFee()).toEqual({ ok: true });
    expect(patchCalls()).toHaveLength(1);
    const init = patchCalls()[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ paymentWindowDays: 5 });
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe("org_1");
    expect(putCalls()).toEqual([]);
    expect(lastReportedFeePart().isDirty).toBe(false);
  });

  it("shows the owner of a free published competition that the fee stays free", async () => {
    await mountWith(LOCKED_FREE);

    expect({
      free: screen.queryByText("Pendaftaran gratis.") !== null,
      windowField: screen.queryByLabelText("Batas waktu pembayaran (hari)"),
      reason: screen.getByRole("status").textContent,
      isDirty: lastReportedFeePart().isDirty,
    }).toEqual({ free: true, windowField: null, reason: PRICE_REASON, isDirty: false });
  });

  it("shows a staff member of a free published competition that the fee stays free", async () => {
    await mountWith(LOCKED_FREE, false);

    expect({
      free: screen.queryByText("Pendaftaran gratis.") !== null,
      windowField: screen.queryByLabelText("Batas waktu pembayaran (hari)"),
      reason: screen.getByRole("status").textContent,
      isDirty: lastReportedFeePart().isDirty,
    }).toEqual({ free: true, windowField: null, reason: PRICE_REASON, isDirty: false });
  });

  it("names the publish lock when the server refuses a new price", async () => {
    await mountWith(PAID);

    fireEvent.click(acknowledgement());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: "competition_fee_locked_after_publish" } }),
            { status: 409 },
          ),
        ),
    );

    expect(await saveReportedFee()).toEqual({ ok: false, errorMessage: PRICE_REASON });
  });

  it.each([
    {
      code: "competition_fee_blocked_active_registrations",
      message:
        "Biaya pendaftaran tidak dapat diubah karena kompetisi ini masih memiliki pendaftar aktif. Hubungi tim Lombakita.",
    },
    {
      code: "competition_changed_during_edit",
      message:
        "Kompetisi ini baru saja diubah atau diterbitkan. Muat ulang halaman lalu coba lagi.",
    },
  ])("names why the server refuses a draft's new price ($code)", async ({ code, message }) => {
    await mountWith(PAID);

    fireEvent.click(acknowledgement());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status: 409 })),
    );

    expect(await saveReportedFee()).toEqual({ ok: false, errorMessage: message });
  });
});
