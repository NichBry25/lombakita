// @vitest-environment jsdom
//
// The CLIENT half of the prize lock. The server refuses a prize save on a published competition,
// and is proven against a real database. What is asserted here is that the host is never offered a
// way to attempt one, and that a refusal that still arrives is explained on screen.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { formatRupiah } from "@/lib/finance/payment-display";
import { CompetitionPrizesEditor } from "./competition-prizes-editor";
import {
  CompetitionEditorPartsContext,
  type CompetitionEditorPart,
  type CompetitionPartSaveResult,
  type ReportCompetitionEditorPart,
} from "./competition-editor-parts";

const LOCK_SENTENCE = "Hadiah tidak dapat diubah setelah kompetisi terbit.";
const REGISTRATIONS_SENTENCE =
  "Hadiah tidak dapat diubah karena kompetisi ini masih memiliki pendaftar aktif. Hubungi tim Lombakita.";
const HELP_TEXT = /^Tambahkan hadiah kompetisi\./;

const STORED_PRIZE = {
  id: "prize_1",
  rankLabel: "Juara 1",
  title: "Medali Emas",
  cashAmount: "100000.00",
  isCertificate: true,
  description: "Diserahkan saat penutupan.",
  sortOrder: 0,
};

const reportPart = vi.fn<ReportCompetitionEditorPart>();

beforeEach(() => {
  reportPart.mockClear();
});

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

const refusedWith = (code: string): Response =>
  new Response(JSON.stringify({ error: { code } }), { status: 409 });

// Answers each GET in turn (the last answer repeats) and every PUT with `putAnswer`.
const stubPrizesRoute = (
  getAnswers: Array<() => Response>,
  putAnswer: () => Response = () => okJson({}),
) => {
  const queue = [...getAnswers];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") return putAnswer();
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (!answer) throw new Error("unexpected GET");
    return answer();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const getCount = (fetchMock: ReturnType<typeof stubPrizesRoute>): number =>
  fetchMock.mock.calls.filter(([, init]) => init?.method !== "PUT").length;

const mountEditor = async () => {
  render(
    <UIPrimitivesProvider>
      <CompetitionEditorPartsContext.Provider value={reportPart}>
        <CompetitionPrizesEditor competitionId="comp_1" expectedUserId="org_1" />
      </CompetitionEditorPartsContext.Provider>
    </UIPrimitivesProvider>,
  );
  await screen.findByRole("heading", { name: "Hadiah" });
  await act(async () => {});
};

const lastReportedPart = (): CompetitionEditorPart => {
  const reports = reportPart.mock.calls.filter(([key]) => key === "prizes");
  const part = reports[reports.length - 1]?.[1];
  if (!part) throw new Error("the prizes editor reported no part");
  return part;
};

const saveReportedPart = async (): Promise<CompetitionPartSaveResult | undefined> => {
  let result: CompetitionPartSaveResult | undefined;
  await act(async () => {
    result = await lastReportedPart().save();
  });
  return result;
};

describe("CompetitionPrizesEditor on a locked competition", () => {
  it("shows each prize read only with the lock sentence and no way to change it", async () => {
    stubPrizesRoute([() => okJson({ prizes: [STORED_PRIZE], locked: true })]);

    await mountEditor();

    expect(await screen.findByText(LOCK_SENTENCE)).toBeTruthy();
    expect(screen.getByText("Juara 1")).toBeTruthy();
    expect(screen.getByText("Medali Emas")).toBeTruthy();
    // Intl separates "Rp" from the figure with a no-break space, which the text matcher folds away.
    expect(screen.getByText(formatRupiah(100_000, "IDR").replace(/\s/g, " "))).toBeTruthy();
    expect(screen.getByText("Sertifikat")).toBeTruthy();
    expect(screen.getByText("Diserahkan saat penutupan.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tambah hadiah" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Hapus hadiah/ })).toBeNull();
    expect(screen.queryByLabelText(/^Nama hadiah/)).toBeNull();
    expect(screen.queryByText(HELP_TEXT)).toBeNull();
  });

  it("shows nothing for a field a prize leaves empty", async () => {
    stubPrizesRoute([
      () =>
        okJson({
          prizes: [
            {
              ...STORED_PRIZE,
              rankLabel: null,
              cashAmount: null,
              isCertificate: false,
              description: null,
            },
          ],
          locked: true,
        }),
    ]);

    await mountEditor();

    expect(await screen.findByText("Medali Emas")).toBeTruthy();
    expect(screen.queryByText("Sertifikat")).toBeNull();
    expect(screen.queryByText(/^Rp/)).toBeNull();
  });

  it("says there are no prizes when a locked list is empty", async () => {
    stubPrizesRoute([() => okJson({ prizes: [], locked: true })]);

    await mountEditor();

    expect(await screen.findByText("Belum ada hadiah.")).toBeTruthy();
    expect(screen.getByText(LOCK_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tambah hadiah" })).toBeNull();
  });

  it("treats an answer without a lock field as locked", async () => {
    stubPrizesRoute([() => okJson({ prizes: [STORED_PRIZE] })]);

    await mountEditor();

    expect(await screen.findByText(LOCK_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tambah hadiah" })).toBeNull();
  });
});

describe("CompetitionPrizesEditor on a draft", () => {
  it("offers the inputs, the add control and the help text", async () => {
    stubPrizesRoute([() => okJson({ prizes: [STORED_PRIZE], locked: false })]);

    await mountEditor();

    expect(await screen.findByRole("button", { name: "Tambah hadiah" })).toBeTruthy();
    expect(screen.getByLabelText(/^Nama hadiah/)).toBeTruthy();
    expect(screen.getByText(HELP_TEXT)).toBeTruthy();
    expect(screen.queryByText(LOCK_SENTENCE)).toBeNull();
  });

  it("reloads the prizes and turns read only after a refusal for a published competition", async () => {
    const fetchMock = stubPrizesRoute(
      [
        () => okJson({ prizes: [STORED_PRIZE], locked: false }),
        () => okJson({ prizes: [STORED_PRIZE], locked: true }),
      ],
      () => refusedWith("competition_prizes_locked_after_publish"),
    );
    await mountEditor();
    await screen.findByRole("button", { name: "Tambah hadiah" });

    const result = await saveReportedPart();

    expect(result).toEqual({ ok: false, errorMessage: LOCK_SENTENCE });
    expect(getCount(fetchMock)).toBe(2);
    expect(await screen.findByText(LOCK_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tambah hadiah" })).toBeNull();
    expect(screen.queryByLabelText(/^Nama hadiah/)).toBeNull();
  });

  it("shows the registrations sentence and keeps the rows after a refusal for active registrants", async () => {
    const fetchMock = stubPrizesRoute(
      [() => okJson({ prizes: [STORED_PRIZE], locked: false })],
      () => refusedWith("competition_prizes_held_by_registrations"),
    );
    await mountEditor();
    await screen.findByRole("button", { name: "Tambah hadiah" });

    const result = await saveReportedPart();

    expect(result).toEqual({ ok: false, errorMessage: REGISTRATIONS_SENTENCE });
    expect(getCount(fetchMock)).toBe(1);
    expect(screen.getByRole("button", { name: "Tambah hadiah" })).toBeTruthy();
    expect((screen.getByLabelText(/^Nama hadiah/) as HTMLInputElement).value).toBe("Medali Emas");
  });
});
