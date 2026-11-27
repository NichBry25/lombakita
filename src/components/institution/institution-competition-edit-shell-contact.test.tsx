// @vitest-environment jsdom
//
// The contact part inside the edit shell: on a draft's step 5 Terbitkan saves it before publishing,
// and in section 1 of a published competition Simpan saves it. The harness is the one of
// institution-competition-edit-shell.test.tsx.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import type { CompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
import { InstitutionCompetitionEditShell } from "./institution-competition-edit-shell";
import { CompetitionContactEditor } from "./competition-contact-editor";

const { mockPush, mockReplace } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
}));

// PageTransitionProvider reads the pathname; the shell reads the router for its navigations.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: mockPush, replace: mockReplace }),
  usePathname: () => "/institution/institusi-contoh/competitions/lomba-contoh-2026/edit",
}));

// jsdom does no layout, so it has no scrollIntoView; a failed Lanjut or Simpan scrolls to the first error.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

// The vitest config clears no mocks between tests.
beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
});

const DAY = 24 * 60 * 60 * 1000;

const validTimeline = () => {
  const now = Date.now();
  return {
    registrationStartAt: new Date(now + 7 * DAY).toISOString(),
    registrationEndAt: new Date(now + 14 * DAY).toISOString(),
    participantConfirmationAt: new Date(now + 20 * DAY).toISOString(),
    eventStartAt: new Date(now + 30 * DAY).toISOString(),
    eventEndAt: new Date(now + 31 * DAY).toISOString(),
    resultAnnouncementAt: new Date(now + 40 * DAY).toISOString(),
  };
};

const COMPETITION = {
  id: "comp_1",
  slug: "lomba-contoh-2026",
  title: "Lomba Contoh 2026",
  description: "Deskripsi kompetisi untuk pengujian.",
  category: "hackathon",
  mode: "individual",
  location: "online",
  minTeamSize: null,
  maxTeamSize: null,
  status: "draft",
  minimumParticipantEntries: 0,
  allowCancellation: false,
  cancellationCutoffDays: null,
  ...validTimeline(),
};

const READY = { canPublish: true, blockers: [] as const };
const CONTACT_MISSING = {
  canPublish: false,
  blockers: ["competition_organizer_contact_missing" as const],
};
const CONTACT_MISSING_REASON =
  "Kontak untuk peserta belum diisi. Isi nomor WhatsApp, nomor telepon, atau email yang dapat dihubungi peserta.";

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const failedJson = (body: unknown): Response =>
  ({ ok: false, json: async () => body }) as unknown as Response;

const loadOk = (publishReadiness: unknown) =>
  okJson({ competition: COMPETITION, publishReadiness });

const draftContact = (mobileNumber: string | null) =>
  okJson({
    contact: null,
    isDraft: true,
    suggestion: { mobileNumber, email: "budi@example.test" },
  });

const SAVED_CONTACT = () => okJson({ contact: { kind: "whatsapp", value: "6281234567890" } });

// Answers in the order the shell asks, and records what it asked, so a test that drifts out of
// sequence fails loudly instead of silently reading the wrong response. Each answer waits one
// macrotask, as a network answer does, so a reload commits its skeleton and remounts the parts.
const stubFetchSequence = (responses: Array<() => Response>) => {
  const queue = [...responses];
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request: ${calls[calls.length - 1]}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return next();
    }),
  );

  return calls;
};

const shellWithContactAt = (step: 1 | 5, initialPublishReadiness: CompetitionPublishReadiness) => (
  <UIPrimitivesProvider>
    <PageTransitionProvider>
      <InstitutionCompetitionEditShell
        institutionSlug="institusi-contoh"
        competitionId="comp_1"
        expectedUserId="org_1"
        initialPublishReadiness={initialPublishReadiness}
        step={step}
        stepChildren={{ 1: <p>Sub-editor langkah 1</p> }}
        contactEditor={<CompetitionContactEditor competitionId="comp_1" expectedUserId="org_1" />}
      />
    </PageTransitionProvider>
  </UIPrimitivesProvider>
);

const readinessNote = () => document.getElementById("publish-readiness-message");
const publishButton = () => screen.getByRole("button", { name: "Terbitkan" });

const COMPETITION_URL = "GET /api/v1/competitions/comp_1";
const CONTACT_GET = "GET /api/v1/competitions/comp_1/contact";
const CONTACT_PUT = "PUT /api/v1/competitions/comp_1/contact";
const PUBLISH_POST = "POST /api/v1/institutions/institusi-contoh/competitions/comp_1/publish";

describe("the contact part in the edit shell", () => {
  it("fills the contact on step 5 and saves it before publishing", async () => {
    const calls = stubFetchSequence([
      () => loadOk(CONTACT_MISSING),
      () => draftContact("0812-3456-7890"),
      SAVED_CONTACT,
      () => okJson({ competition: { ...COMPETITION, status: "published" } }),
    ]);

    render(shellWithContactAt(5, CONTACT_MISSING));

    const field = await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    expect((field as HTMLInputElement).value).toBe("0812-3456-7890");
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(CONTACT_MISSING_REASON)).toBeNull();
    // Nothing blocks publishing, so the bar holds Terbitkan and no sentence.
    expect(readinessNote()).toBeNull();
    expect(screen.queryByText("Draf belum bisa diterbitkan.")).toBeNull();

    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        "/institution/institusi-contoh/competitions/lomba-contoh-2026",
      ),
    );
    expect(calls).toEqual([COMPETITION_URL, CONTACT_GET, CONTACT_PUT, PUBLISH_POST]);
  });

  it("names the missing contact and hides Terbitkan while the field is empty", async () => {
    stubFetchSequence([() => loadOk(CONTACT_MISSING), () => draftContact(null)]);

    render(shellWithContactAt(5, CONTACT_MISSING));

    const field = await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    expect((field as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Terbitkan" })).toBeNull();
    // The notice names the reason, and the bar says only that publishing is not possible yet.
    expect(screen.getByText(CONTACT_MISSING_REASON)).toBeTruthy();
    expect(document.querySelector(".form-action-bar-panel .bar-note")?.textContent).toBe(
      "Belum bisa diterbitkan",
    );
    expect(screen.queryByRole("link", { name: "Isi kontak" })).toBeNull();
  });

  it("publishes nothing when the contact is refused", async () => {
    const calls = stubFetchSequence([
      () => loadOk(CONTACT_MISSING),
      () => draftContact("+1 555 123 4567"),
      () =>
        new Response(
          JSON.stringify({ error: { code: "competition_organizer_contact_not_indonesian" } }),
          { status: 400 },
        ),
    ]);

    render(shellWithContactAt(5, CONTACT_MISSING));

    await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(false));
    fireEvent.click(publishButton());

    expect(
      await screen.findByText(
        "Kontak untuk peserta belum tersimpan. Nomor WhatsApp harus nomor ponsel Indonesia, misalnya 0812 3456 7890. Untuk nomor lain, pilih Telepon.",
      ),
    ).toBeTruthy();
    expect(calls).toEqual([COMPETITION_URL, CONTACT_GET, CONTACT_PUT]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("reloads the readiness when the publish is refused after the contact was saved", async () => {
    const calls = stubFetchSequence([
      () => loadOk(CONTACT_MISSING),
      () => draftContact("0812-3456-7890"),
      SAVED_CONTACT,
      () => failedJson({ error: { code: "institution_suspended" } }),
      () => loadOk({ canPublish: false, blockers: ["institution_suspended"] }),
      () =>
        okJson({
          contact: { kind: "whatsapp", value: "6281234567890" },
          isDraft: true,
          suggestion: null,
        }),
    ]);

    render(shellWithContactAt(5, CONTACT_MISSING));

    await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(false));
    fireEvent.click(publishButton());

    await waitFor(() => expect(calls).toHaveLength(6));
    expect(calls[4]).toBe(COMPETITION_URL);
    // The toast says the same sentence, so the notice's list is read by itself.
    const reasonsList = () => document.querySelector(".publish-reasons-list")?.textContent;
    await waitFor(() =>
      expect(reasonsList()).toContain(
        "Institusi ini sedang ditangguhkan oleh tim Lombakita. Kompetisi tidak dapat diterbitkan.",
      ),
    );
    expect(reasonsList()).not.toContain(CONTACT_MISSING_REASON);
  });

  describe("when the press may open a host check", () => {
    const WAIT_SENTENCE = "Perkiraan 1x24 jam pada hari kerja.";
    const NEEDED_SENTENCE = `Kompetisi pertama Anda diperiksa staf sebelum tayang. ${WAIT_SENTENCE}`;
    const PENDING_SENTENCE = `Staf Lombakita sedang memeriksa kompetisi ini. ${WAIT_SENTENCE}`;
    const SENT_TOAST = `Kompetisi dikirim untuk diperiksa. ${WAIT_SENTENCE}`;

    const neededReadiness: CompetitionPublishReadiness = {
      canPublish: true,
      blockers: [],
      hostCheck: { state: "needed" },
    };
    const pendingReadiness: CompetitionPublishReadiness = {
      canPublish: true,
      blockers: [],
      hostCheck: { state: "pending" },
    };
    const savedContact = () =>
      okJson({
        contact: { kind: "whatsapp", value: "6281234567890" },
        isDraft: true,
        suggestion: null,
      });
    const acceptedAsHostCheck = () =>
      ({
        ok: true,
        status: 202,
        json: async () => ({
          hostCheck: {
            id: "check_1",
            status: "pending_review",
            submittedAt: "2026-11-25T08:00:00.000Z",
          },
        }),
      }) as unknown as Response;

    it("sends the draft for a host check from step 5 and opens the management page without saying it was published", async () => {
      const calls = stubFetchSequence([
        () => loadOk(neededReadiness),
        savedContact,
        acceptedAsHostCheck,
      ]);

      render(shellWithContactAt(5, neededReadiness));

      expect(await screen.findByText(NEEDED_SENTENCE)).toBeTruthy();
      const sendButton = () => screen.getByRole("button", { name: "Kirim untuk diperiksa" });
      await waitFor(() => expect(sendButton().hasAttribute("disabled")).toBe(false));

      fireEvent.click(sendButton());

      expect(await screen.findByText(SENT_TOAST)).toBeTruthy();
      expect(screen.queryByText("Kompetisi diterbitkan.")).toBeNull();
      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(
          "/institution/institusi-contoh/competitions/lomba-contoh-2026",
        ),
      );
      expect(calls).toEqual([COMPETITION_URL, CONTACT_GET, PUBLISH_POST]);
    });

    it("shows Sedang diperiksa on step 5 and sends nothing when it is pressed", async () => {
      const calls = stubFetchSequence([() => loadOk(pendingReadiness), savedContact]);

      render(shellWithContactAt(5, pendingReadiness));

      const waitingButton = await screen.findByRole("button", { name: "Sedang diperiksa" });
      expect(waitingButton.hasAttribute("disabled")).toBe(true);
      expect(waitingButton.getAttribute("aria-describedby")).toBe("publish-host-check-note");
      expect(screen.getByText(PENDING_SENTENCE)).toBeTruthy();

      fireEvent.click(waitingButton);

      expect(calls).toEqual([COMPETITION_URL, CONTACT_GET]);
    });
  });

  it("keeps the contact in section 1 of a published competition and saves it with Simpan", async () => {
    const published = { ...COMPETITION, status: "published" };
    const calls = stubFetchSequence([
      () => okJson({ competition: published, publishReadiness: READY }),
      () => okJson({ contact: null, isDraft: false, suggestion: null }),
      SAVED_CONTACT,
      () => okJson({ competition: published, publishReadiness: READY }),
      () =>
        okJson({
          contact: { kind: "whatsapp", value: "6281234567890" },
          isDraft: false,
          suggestion: null,
        }),
    ]);

    render(shellWithContactAt(1, { canPublish: true, blockers: [] }));

    const field = await screen.findByLabelText(/^Nomor WhatsApp(?: \* \(wajib\)| \(opsional\))?$/);
    expect((field as HTMLInputElement).value).toBe("");
    expect(
      screen.getByText(
        "Dengan menyimpan, Anda menyetujui kontak ini tampil untuk umum dan dapat muncul di mesin pencari.",
      ),
    ).toBeTruthy();

    fireEvent.change(field, { target: { value: "0812 3456 7890" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(calls).toHaveLength(5));
    expect(calls).toEqual([
      COMPETITION_URL,
      CONTACT_GET,
      CONTACT_PUT,
      COMPETITION_URL,
      CONTACT_GET,
    ]);
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(putCall![1]!.body as string)).toEqual({
      kind: "whatsapp",
      value: "0812 3456 7890",
    });
  });

  it("shows no contact on a draft's earlier steps", async () => {
    const calls = stubFetchSequence([() => loadOk(READY)]);

    render(shellWithContactAt(1, { canPublish: true, blockers: [] }));

    expect(await screen.findByRole("heading", { name: "Informasi utama" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Kontak untuk peserta" })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
