// @vitest-environment jsdom
//
// The CLIENT half of the disclosure gate, which the browser assertions structurally cannot see:
// `ui-states` reads rendered text, so a Save button that became enabled without an acknowledgement
// looks identical to one that did not. Weakening `canEnable` left every browser case green.
//
// The server gate is the enforcement and is proven against a real database. What is asserted here
// is that the organiser is never invited to consent to a disclosure that is not on the screen.

import { describe, expect, it, vi } from "vitest";
// `fireEvent` rather than user-event: the latter is not a dependency of this project and a
// checkbox click plus a text change do not need its extra fidelity.
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionFeeSection } from "./competition-fee-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const RULE = {
  basisPoints: 250,
  flatAmount: 0,
  currency: "IDR",
  minimumFeeAmount: null,
  maximumFeeAmount: null,
};

const mountWith = async (body: unknown) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => body } as Response),
  );

  render(
    <UIPrimitivesProvider>
      <CompetitionFeeSection competitionId="comp_1" expectedUserId="org_1" />
    </UIPrimitivesProvider>,
  );

  // The section loads its own state, so nothing is asserted until the skeleton is gone.
  return screen.findByRole("heading", { name: "Biaya pendaftaran" });
};

const mountRefused = async (code: string, status: number) => {
  // A real Response: the section reads the code through readErrorCode, which reads a clone.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status })),
  );

  render(
    <UIPrimitivesProvider>
      <CompetitionFeeSection competitionId="comp_1" expectedUserId="org_1" />
    </UIPrimitivesProvider>,
  );

  // The refused state renders the same heading as the loaded form.
  return screen.findByRole("heading", { name: "Biaya pendaftaran" });
};

const OWNER_ONLY_MESSAGE = "Hanya pemilik institusi yang dapat mengatur biaya pendaftaran.";

const LOAD_FAILURE_MESSAGE = "Biaya pendaftaran gagal dimuat. Muat ulang halaman lalu coba lagi.";

const saveButton = () => screen.getByRole("button", { name: /Simpan biaya pendaftaran/ });

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
    await mountWith({
      pricing: { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 },
      feeRule: RULE,
    });

    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /menyetujui/ }));

    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("REVOKES the acknowledgement when the amount changes", async () => {
    // Consent does not survive a change to what is being consented to. Without this, an organiser
    // could agree to the fee on Rp 10.000 and save a price of Rp 10.000.000.
    await mountWith({
      pricing: { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 },
      feeRule: RULE,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /menyetujui/ }));
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    fireEvent.change(screen.getByLabelText("Biaya per pendaftaran"), {
      target: { value: "1500000" },
    });

    expect(saveButton().hasAttribute("disabled")).toBe(true);
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
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("WITHHOLDS the whole disclosure on a free competition", async () => {
    await mountWith({
      pricing: { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 },
      feeRule: RULE,
    });

    expect(screen.queryByText("Rincian per pendaftaran")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /menyetujui/ })).toBeNull();
    // Save stays available: clearing a fee needs no acknowledgement, and the server agrees.
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("tells a staff member that only the owner sets the fee when the load is forbidden", async () => {
    await mountRefused("forbidden", 403);

    expect(screen.getByRole("status").textContent).toBe(OWNER_ONLY_MESSAGE);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the load failure as an error for any other refused load", async () => {
    await mountRefused("competition_not_found", 404);

    expect(screen.getByRole("alert").textContent).toBe(LOAD_FAILURE_MESSAGE);
  });
});
