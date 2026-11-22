// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import {
  CompetitionEditorPartsContext,
  type CompetitionEditorPart,
  type CompetitionPartSaveResult,
} from "@/components/institution/competition-editor-parts";
import { CompetitionEligibilityEditor } from "./competition-eligibility-editor";

const COMPETITION_ID = "comp_1";
const URL_OF_PART = `/api/v1/competitions/${COMPETITION_ID}/eligibility`;

type Loaded = { eligibilityNote: string | null; audience: string[] | null };

const reportedPart: { current: CompetitionEditorPart | null } = { current: null };

const stubEligibility = (loaded: Loaded, putAnswer?: Response) => {
  const putBodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)));
        return putAnswer ?? new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify(loaded), { status: 200 });
    }),
  );
  return putBodies;
};

const mount = () =>
  render(
    <UIPrimitivesProvider>
      <CompetitionEditorPartsContext.Provider
        value={(key, part) => {
          if (key === "eligibility") reportedPart.current = part;
        }}
      >
        <CompetitionEligibilityEditor competitionId={COMPETITION_ID} expectedUserId="user_1" />
      </CompetitionEditorPartsContext.Provider>
    </UIPrimitivesProvider>,
  );

const saveReportedPart = async (): Promise<CompetitionPartSaveResult> => {
  const part = reportedPart.current;
  if (!part) throw new Error("the part reported nothing");
  return part.save();
};

const tick = (name: string): HTMLInputElement =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

beforeEach(() => {
  reportedPart.current = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the audience of the eligibility part", () => {
  it("shows the five levels in the fixed order under the sentence that restricts no one", async () => {
    stubEligibility({ eligibilityNote: null, audience: null });
    mount();

    await screen.findByRole("group", { name: "Untuk" });
    const labels = screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent);

    expect(labels).toEqual(["Umum", "Mahasiswa", "SMA/SMK", "SMP", "SD"]);
    expect(
      screen.getByText(
        "Informasi kelayakan bersifat deskriptif dan tidak membatasi siapa pun untuk mendaftar.",
      ),
    ).toBeTruthy();
  });

  it("starts from the saved audience and is clean until a box changes", async () => {
    stubEligibility({ eligibilityNote: null, audience: ["umum", "smp"] });
    mount();

    await screen.findByRole("group", { name: "Untuk" });

    expect({
      umum: tick("Umum").checked,
      smp: tick("SMP").checked,
      sd: tick("SD").checked,
      dirty: reportedPart.current?.isDirty,
    }).toEqual({ umum: true, smp: true, sd: false, dirty: false });
  });

  it("sends the ticked levels in the fixed order together with the note", async () => {
    const puts = stubEligibility({ eligibilityNote: "Catatan.", audience: null });
    mount();
    await screen.findByRole("group", { name: "Untuk" });

    fireEvent.click(tick("SD"));
    fireEvent.click(tick("Mahasiswa"));
    await waitFor(() => expect(reportedPart.current?.isDirty).toBe(true));
    const result = await saveReportedPart();

    expect({ result, puts }).toEqual({
      result: { ok: true },
      puts: [{ eligibilityNote: "Catatan.", audience: ["mahasiswa", "sd"] }],
    });
  });

  it("sends an empty list when every box is cleared", async () => {
    const puts = stubEligibility({ eligibilityNote: null, audience: ["mahasiswa"] });
    mount();
    await screen.findByRole("group", { name: "Untuk" });

    fireEvent.click(tick("Mahasiswa"));
    await saveReportedPart();

    expect(puts).toEqual([{ eligibilityNote: "", audience: [] }]);
  });

  it("gives the reload copy when the server refuses to empty a published competition", async () => {
    stubEligibility(
      { eligibilityNote: null, audience: ["mahasiswa"] },
      new Response(
        JSON.stringify({ error: { code: "competition_changed_during_edit", message: "x" } }),
        { status: 409 },
      ),
    );
    mount();
    await screen.findByRole("group", { name: "Untuk" });

    fireEvent.click(tick("Mahasiswa"));
    const result = await saveReportedPart();

    expect(result).toEqual({
      ok: false,
      errorMessage:
        "Kompetisi ini baru saja diubah atau diterbitkan. Muat ulang halaman lalu coba lagi.",
    });
  });

  it("says a published competition keeps at least one choice when the server refuses to empty it", async () => {
    stubEligibility(
      { eligibilityNote: null, audience: ["mahasiswa"] },
      new Response(
        JSON.stringify({
          error: { code: "competition_audience_cannot_be_emptied", message: "x" },
        }),
        { status: 409 },
      ),
    );
    mount();
    await screen.findByRole("group", { name: "Untuk" });

    fireEvent.click(tick("Mahasiswa"));
    const result = await saveReportedPart();

    expect(result).toEqual({
      ok: false,
      errorMessage:
        "Untuk tidak bisa dikosongkan setelah kompetisi terbit. Biarkan minimal satu pilihan.",
    });
  });
});

describe("the eligibility request", () => {
  it("is the route the part has always used", async () => {
    stubEligibility({ eligibilityNote: null, audience: null });
    mount();
    await screen.findByRole("group", { name: "Untuk" });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(URL_OF_PART);
  });
});
