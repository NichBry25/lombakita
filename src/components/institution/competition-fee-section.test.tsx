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

  it("tells a staff member that only the owner sets the fee, without asking the server", async () => {
    await mountRefused("forbidden", 403, false);

    expect(screen.getByRole("status").textContent).toBe(OWNER_ONLY_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports no fee part to the editor for a staff member", async () => {
    await mountRefused("forbidden", 403, false);

    expect(feeReports()).toEqual([]);
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
});
