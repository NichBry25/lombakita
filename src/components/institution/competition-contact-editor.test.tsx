// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionContactEditor } from "./competition-contact-editor";
import {
  CompetitionEditorPartsContext,
  type CompetitionPartSaveResult,
  type ReportCompetitionEditorPart,
} from "./competition-editor-parts";

const DRAFT_NOTICE =
  "Dengan menerbitkan, Anda menyetujui kontak ini tampil untuk umum dan dapat muncul di mesin pencari.";
const LIVE_NOTICE =
  "Dengan menyimpan, Anda menyetujui kontak ini tampil untuk umum dan dapat muncul di mesin pencari.";

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const DRAFT_WITH_NUMBER = {
  contact: null,
  isDraft: true,
  suggestion: { mobileNumber: "0812-3456-7890", email: "budi@example.test" },
};

// Answers the GET with `loaded`, and every PUT with `saved`.
const stubFetch = (loaded: Response, saved?: Response) => {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    if (init?.method === "PUT") return saved ?? okJson({});
    return loaded;
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
};

const renderEditor = () => {
  const reportPart = vi.fn<ReportCompetitionEditorPart>();
  const lastReportedPart = () => {
    const reports = reportPart.mock.calls.filter(([key]) => key === "contact");
    return reports[reports.length - 1]?.[1];
  };
  render(
    <UIPrimitivesProvider>
      <CompetitionEditorPartsContext.Provider value={reportPart}>
        <CompetitionContactEditor competitionId="comp_1" expectedUserId="org_1" />
      </CompetitionEditorPartsContext.Provider>
    </UIPrimitivesProvider>,
  );
  return { lastReportedPart };
};

const saveThroughPart = async (
  lastReportedPart: ReturnType<typeof renderEditor>["lastReportedPart"],
): Promise<CompetitionPartSaveResult | undefined> => {
  let result: CompetitionPartSaveResult | undefined;
  await act(async () => {
    result = await lastReportedPart()?.save();
  });
  return result;
};

describe("CompetitionContactEditor", () => {
  it("fills a draft's contact with the sign-up number as WhatsApp, under the publish notice", async () => {
    const fetchSpy = stubFetch(okJson(DRAFT_WITH_NUMBER));
    const { lastReportedPart } = renderEditor();

    const field = await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    expect(screen.getByRole("button", { name: "WhatsApp" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect((field as HTMLInputElement).value).toBe("0812-3456-7890");
    expect(screen.getByText(DRAFT_NOTICE)).toBeTruthy();
    // The part reports from an effect, which runs after the render that showed the field.
    await waitFor(() => expect(lastReportedPart()?.isDirty).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/competitions/comp_1/contact",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("keeps the typed number when switching to Telepon, and fills the account email for Email", async () => {
    stubFetch(okJson(DRAFT_WITH_NUMBER));
    renderEditor();
    await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);

    fireEvent.click(screen.getByRole("button", { name: "Telepon" }));
    expect(
      (screen.getByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/) as HTMLInputElement)
        .value,
    ).toBe("0812-3456-7890");
    expect(screen.getByRole("button", { name: "Telepon" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    expect(
      (screen.getByLabelText(/^Alamat email(?: \* \(wajib\)| \(opsional\))?$/) as HTMLInputElement)
        .value,
    ).toBe("budi@example.test");
  });

  it("shows a saved contact as stored, with nothing to save, under the save notice", async () => {
    stubFetch(
      okJson({
        contact: { kind: "phone", value: "6281234567890" },
        isDraft: false,
        suggestion: null,
      }),
    );
    const { lastReportedPart } = renderEditor();

    const field = await screen.findByLabelText(/^Nomor telepon(?: \* \(wajib\)| \(opsional\))?$/);
    expect(screen.getByRole("button", { name: "Telepon" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect((field as HTMLInputElement).value).toBe("+6281234567890");
    expect(screen.getByText(LIVE_NOTICE)).toBeTruthy();
    expect(lastReportedPart()?.isDirty).toBe(false);
  });

  it("leaves the field empty when there is no sign-up number to fill it with", async () => {
    stubFetch(
      okJson({
        contact: null,
        isDraft: true,
        suggestion: { mobileNumber: null, email: "budi@example.test" },
      }),
    );
    const { lastReportedPart } = renderEditor();

    const field = await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    expect((field as HTMLInputElement).value).toBe("");
    expect(lastReportedPart()?.isDirty).toBe(false);
  });

  it("saves the typed contact through its own route and shows it as stored", async () => {
    const fetchSpy = stubFetch(
      okJson(DRAFT_WITH_NUMBER),
      okJson({ contact: { kind: "whatsapp", value: "6281234567890" } }),
    );
    const { lastReportedPart } = renderEditor();
    await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);

    const result = await saveThroughPart(lastReportedPart);

    expect(result).toEqual({ ok: true });
    const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall?.[0]).toBe("/api/v1/competitions/comp_1/contact");
    const headers = new Headers(putCall?.[1]?.headers);
    expect(headers.get("X-Expected-User-Id")).toBe("org_1");
    expect(JSON.parse(putCall?.[1]?.body as string)).toEqual({
      kind: "whatsapp",
      value: "0812-3456-7890",
    });
    expect(
      (
        screen.getByLabelText(
          /^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/,
        ) as HTMLInputElement
      ).value,
    ).toBe("+6281234567890");
    expect(lastReportedPart()?.isDirty).toBe(false);
  });

  it("says why a WhatsApp number outside Indonesia was refused", async () => {
    stubFetch(
      okJson(DRAFT_WITH_NUMBER),
      new Response(
        JSON.stringify({ error: { code: "competition_organizer_contact_not_indonesian" } }),
        { status: 400 },
      ),
    );
    const { lastReportedPart } = renderEditor();
    await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);

    const result = await saveThroughPart(lastReportedPart);

    expect(result).toEqual({
      ok: false,
      errorMessage:
        "Nomor WhatsApp harus nomor ponsel Indonesia, misalnya 0812 3456 7890. Untuk nomor lain, pilih Telepon.",
    });
  });

  it("refuses to clear a saved contact without sending anything", async () => {
    const fetchSpy = stubFetch(
      okJson({
        contact: { kind: "whatsapp", value: "6281234567890" },
        isDraft: false,
        suggestion: null,
      }),
    );
    const { lastReportedPart } = renderEditor();
    const field = await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);

    fireEvent.change(field, { target: { value: "" } });
    expect(lastReportedPart()?.isDirty).toBe(true);

    const result = await saveThroughPart(lastReportedPart);

    expect(result).toEqual({
      ok: false,
      errorMessage: "Kontak yang sudah tersimpan dapat diganti, tetapi tidak dapat dikosongkan.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the load failure in place of the fields and reports nothing to save", async () => {
    stubFetch(new Response(null, { status: 500 }));
    const { lastReportedPart } = renderEditor();

    expect(
      await screen.findByText(
        "Kontak untuk peserta gagal dimuat. Muat ulang halaman lalu coba lagi.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(lastReportedPart()?.isDirty).toBe(false);
  });
});
