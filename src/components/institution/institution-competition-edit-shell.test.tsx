// @vitest-environment jsdom
//
// WHAT THIS FILE EXISTS TO PIN (C2.2).
//
// F5: a readiness answer the shell could not REFRESH must not keep the publish control disabled. The server is still the authority — pressing Terbitkan sends
// the attempt, and a refusal comes back as Indonesian text through `competition-publish-messages` —
// so an unknown answer disables nothing and prints no reason. A reason is a claim about what the
// server will do, and after a failed read the shell has just admitted it does not know.
//
// The SECOND save is what makes the F5 test able to fail. A single failed refetch proves only that
// the control is enabled afterwards; it is satisfied by an implementation that never becomes ready
// again, which would leave the reason permanently unreachable. The sequence therefore runs
// known-blocked → unknown → known-blocked and asserts each state.
//
// A2: a DISABLED Terbitkan must always carry a visible reason. The server's checklist reason is
// dropped only when the shell is already saying the same thing about this form: on missing fields,
// out-of-order dates and a registration window that has CLOSED (competition-core.ts:877-883).
//
// A6: a successful read clears the unknown state even when the response omits the optional
// `publishReadiness` key.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SESSION_MISMATCH_MESSAGE } from "@/lib/session/session-fetch";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { InstitutionCompetitionEditShell } from "./institution-competition-edit-shell";

const { mockPush, mockReplace } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
}));

// PageTransitionProvider reads the pathname; the shell reads the router for its navigations.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: mockPush, replace: mockReplace }),
  usePathname: () => "/institution/institusi-contoh/competitions/lomba-contoh-2026/edit",
}));

// The vitest config clears no mocks between tests.
beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
});

const DAY = 24 * 60 * 60 * 1000;

// A checklist-valid, future-dated timeline: registrationStart < registrationEnd <=
// participantConfirmation < eventStart < eventEnd <= resultAnnouncement. The shell validates this
// on the client (`validateCompetitionTimeline`), so a fixture that failed it would disable Terbitkan
// for a reason of the test's own making.
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
  minTeamSize: null,
  maxTeamSize: null,
  status: "draft",
  minimumParticipantEntries: 0,
  allowCancellation: false,
  cancellationCutoffDays: null,
  ...validTimeline(),
};

const BLOCKED = {
  canPublish: false,
  blockers: ["competition_institution_not_verified" as const],
};
const READY = { canPublish: true, blockers: [] as const };

// The exact sentence `competition-publish-messages.ts` renders for that code.
const UNVERIFIED_REASON =
  "Kompetisi berbayar hanya dapat diterbitkan oleh institusi yang sudah terverifikasi.";
const VALIDATION_REASON = "Data kompetisi belum lengkap atau belum valid.";
const REGISTRATION_END_PAST_MESSAGE =
  "Tanggal berakhir pendaftaran sudah lewat. Pilih tanggal mendatang agar kompetisi dapat diterbitkan.";
// The server's message is never shown: a refused load with no known code shows the load fallback.
const SERVER_LOAD_FAILED_MESSAGE = "Gagal memuat kompetisi.";
const LOAD_FAILED_MESSAGE = "Data kompetisi gagal dimuat. Muat ulang halaman lalu coba lagi.";

const BLOCKED_BY_CHECKLIST = {
  canPublish: false,
  blockers: ["competition_publish_validation_failed" as const],
};

// The same competition with its registration window CLOSED and its ordering still valid.
// `getMissingCompetitionPublishFields` reads presence only and `validateCompetitionTimeline`
// compares fields to each other and never to the clock, so the shell reads the clock for the
// registration end on its own (D160) and names that field.
const closedRegistrationWindow = () => {
  const now = Date.now();
  return {
    registrationStartAt: new Date(now - 30 * DAY).toISOString(),
    registrationEndAt: new Date(now - 20 * DAY).toISOString(),
    participantConfirmationAt: new Date(now - 15 * DAY).toISOString(),
    eventStartAt: new Date(now + 10 * DAY).toISOString(),
    eventEndAt: new Date(now + 11 * DAY).toISOString(),
    resultAnnouncementAt: new Date(now + 20 * DAY).toISOString(),
  };
};

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const failedJson = (body: unknown): Response =>
  ({ ok: false, json: async () => body }) as unknown as Response;

const loadOk = (publishReadiness: unknown) =>
  okJson({ competition: COMPETITION, publishReadiness });
// A successful read whose payload omits the OPTIONAL `publishReadiness` key. The type says the key
// may be absent, so the shell has to behave for a response that carries no new answer.
const loadOkWithoutReadiness = okJson({ competition: COMPETITION });
const patchOk = okJson({ competition: COMPETITION });
const loadFailed = failedJson({ error: { message: SERVER_LOAD_FAILED_MESSAGE } });

// Answers in the order the shell asks, and records what it asked, so a test that drifts out of
// sequence fails loudly instead of silently reading the wrong response.
const stubFetchSequence = (responses: Array<() => Response>) => {
  const queue = [...responses];
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request: ${calls[calls.length - 1]}`);
      return next();
    }),
  );

  return calls;
};

const mount = () =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <InstitutionCompetitionEditShell
          institutionSlug="institusi-contoh"
          competitionId="comp_1"
          expectedUserId="org_1"
          initialPublishReadiness={BLOCKED}
        />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const publishButton = () => screen.getByRole("button", { name: "Terbitkan" });
const saveButton = () => screen.getByRole("button", { name: "Simpan" });

describe("InstitutionCompetitionEditShell save body", () => {
  it("does not send an empty patch when a published form has no changes", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([
      () => okJson({ competition, publishReadiness: READY }),
      () =>
        failedJson({
          error: {
            code: "competition_invalid_payload",
            message: "At least one editable competition field is required",
          },
        }),
    ]);
    mount();
    await screen.findByRole("button", { name: "Simpan" });
    fireEvent.click(saveButton());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
    expect(await screen.findByText("Perubahan tersimpan.")).toBeTruthy();
  });

  it("sends the changed cutoff form field after cancellation is toggled back off", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([
      () => okJson({ competition, publishReadiness: READY }),
      () => okJson({ competition }),
      () => okJson({ competition, publishReadiness: READY }),
    ]);
    mount();
    await screen.findByRole("button", { name: "Simpan" });
    const cancellationCheckbox = screen.getByRole("checkbox", {
      name: "Izinkan peserta membatalkan pendaftaran sendiri",
    });
    fireEvent.click(cancellationCheckbox);
    fireEvent.change(screen.getByLabelText("Batas pembatalan (hari sebelum acara mulai)"), {
      target: { value: "3" },
    });
    fireEvent.click(cancellationCheckbox);
    fireEvent.click(saveButton());
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    const patchCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    const body = JSON.parse(patchCall![1]!.body as string);
    expect(body).toEqual({ cancellationCutoffDays: null });
  });

  it.each(["published", "draft"])(
    "sends only changed fields for published saves and every field for drafts (%s)",
    async (status) => {
      const competition = { ...COMPETITION, status, ...closedRegistrationWindow() };
      stubFetchSequence([
        () => okJson({ competition, publishReadiness: READY }),
        () => okJson({ competition }),
        () => okJson({ competition, publishReadiness: READY }),
      ]);
      mount();
      await screen.findByRole("button", { name: "Simpan" });
      fireEvent.change(screen.getByLabelText(/Deskripsi/), { target: { value: "Deskripsi baru" } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
      const patchCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      const body = JSON.parse(patchCall![1]!.body as string);
      if (status === "published") {
        expect(body).toEqual({ description: "Deskripsi baru" });
        return;
      }
      const minuteDate = (iso: string) => {
        const date = new Date(iso);
        date.setSeconds(0, 0);
        return date.toISOString();
      };
      expect(body).toEqual({
        title: competition.title,
        slug: competition.slug,
        description: "Deskripsi baru",
        category: competition.category,
        mode: competition.mode,
        minTeamSize: null,
        maxTeamSize: null,
        minimumParticipantEntries: competition.minimumParticipantEntries,
        participantConfirmationAt: minuteDate(competition.participantConfirmationAt),
        registrationStartAt: minuteDate(competition.registrationStartAt),
        registrationEndAt: minuteDate(competition.registrationEndAt),
        eventStartAt: minuteDate(competition.eventStartAt),
        eventEndAt: minuteDate(competition.eventEndAt),
        resultAnnouncementAt: minuteDate(competition.resultAnnouncementAt),
        allowCancellation: false,
        cancellationCutoffDays: null,
      });
    },
  );

  it("sends only a changed future registration deadline on a published save", async () => {
    const competition = { ...COMPETITION, status: "published", ...validTimeline() };
    const deadline = new Date(competition.registrationEndAt);
    deadline.setDate(deadline.getDate() + 1);
    deadline.setSeconds(0, 0);
    const updated = { ...competition, registrationEndAt: deadline.toISOString() };
    stubFetchSequence([
      () => okJson({ competition, publishReadiness: READY }),
      () => okJson({ competition: updated }),
      () => okJson({ competition: updated, publishReadiness: READY }),
    ]);
    mount();
    await screen.findByRole("button", { name: "Simpan" });
    const deadlineInput = screen.getByLabelText(/Pendaftaran berakhir/);
    const localDeadline = new Date(deadline);
    localDeadline.setMinutes(localDeadline.getMinutes() - localDeadline.getTimezoneOffset());
    fireEvent.change(deadlineInput, {
      target: { value: localDeadline.toISOString().slice(0, 16) },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    const patchCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    const body = JSON.parse(patchCall![1]!.body as string);
    expect(body).toEqual({ registrationEndAt: deadline.toISOString() });
  });

  it("sends no unchanged date key on a published save with stored seconds", async () => {
    const timeline = validTimeline();
    for (const field of Object.keys(timeline) as Array<keyof typeof timeline>) {
      const date = new Date(timeline[field]);
      date.setSeconds(37, 555);
      timeline[field] = date.toISOString();
    }
    const competition = { ...COMPETITION, status: "published", ...timeline };
    stubFetchSequence([
      () => okJson({ competition, publishReadiness: READY }),
      () => okJson({ competition }),
      () => okJson({ competition, publishReadiness: READY }),
    ]);
    mount();
    await screen.findByRole("button", { name: "Simpan" });
    fireEvent.change(screen.getByLabelText(/Deskripsi/), { target: { value: "Deskripsi baru" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    const patchCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    const body = JSON.parse(patchCall![1]!.body as string);
    for (const field of Object.keys(timeline)) {
      expect(Object.hasOwn(body, field), field).toBe(false);
    }
  });

  it.each(["published", "draft"])(
    "sends the immutable fields only for a draft (%s)",
    async (status) => {
      const competition = { ...COMPETITION, status };
      stubFetchSequence([
        () => okJson({ competition, publishReadiness: READY }),
        () => okJson({ competition }),
        () => okJson({ competition, publishReadiness: READY }),
      ]);
      mount();
      await screen.findByRole("button", { name: "Simpan" });
      fireEvent.change(screen.getByLabelText(/Deskripsi/), { target: { value: "Deskripsi baru" } });
      fireEvent.click(saveButton());

      await waitFor(() => {
        const patchCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
        expect(patchCall).toBeDefined();
        const body = JSON.parse(patchCall![1]!.body as string) as Record<string, unknown>;
        expect(body.description).toBe("Deskripsi baru");
        for (const field of [
          "mode",
          "minTeamSize",
          "maxTeamSize",
          "minimumParticipantEntries",
          "participantConfirmationAt",
        ]) {
          expect(Object.hasOwn(body, field), field).toBe(status === "draft");
        }
      });
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    },
  );
});

describe("InstitutionCompetitionEditShell publish readiness", () => {
  it("drops a server refusal it could not refresh, and takes it back when a later read succeeds", async () => {
    const calls = stubFetchSequence([
      () => loadOk(BLOCKED),
      () => patchOk,
      () => loadFailed,
      () => patchOk,
      () => loadOk(BLOCKED),
    ]);

    mount();

    // 1. KNOWN-BLOCKED. The server refused; the control says so and prints the server's reason.
    await screen.findByRole("button", { name: "Terbitkan" });
    expect(publishButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(UNVERIFIED_REASON)).toBeTruthy();

    // 2. UNKNOWN. A save succeeds, the refetch behind it fails. The readiness that provoked this
    // must go with it: the client's own checks pass, so Terbitkan is offered and no reason is shown.
    // The error toast is what tells the user the read failed.
    fireEvent.click(saveButton());

    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(UNVERIFIED_REASON)).toBeNull();
    expect(await screen.findByText(LOAD_FAILED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(SERVER_LOAD_FAILED_MESSAGE)).toBeNull();

    // 3. KNOWN-BLOCKED AGAIN. A second save whose refetch succeeds restores the refusal, which is
    // what proves the unknown state is not sticky.
    fireEvent.click(saveButton());

    // Waits on the reason, not on `disabled`: Terbitkan is also disabled while the save is in
    // flight, before the refetch that restores the refusal has landed.
    expect(await screen.findByText(UNVERIFIED_REASON)).toBeTruthy();
    expect(publishButton().hasAttribute("disabled")).toBe(true);

    expect(calls).toEqual([
      "GET /api/v1/competitions/comp_1",
      "PATCH /api/v1/competitions/comp_1",
      "GET /api/v1/competitions/comp_1",
      "PATCH /api/v1/competitions/comp_1",
      "GET /api/v1/competitions/comp_1",
    ]);
  });

  it("translates a session-mismatch refusal instead of relaying the server's English", async () => {
    // The exact prose `assertSessionMatchesExpectedUser` puts in the envelope (access-core.ts:56-61).
    const SERVER_ENGLISH =
      "Session changed since this page was rendered — reload the page and try again";
    stubFetchSequence([
      () => loadOk(READY),
      () => failedJson({ error: { code: "session_user_mismatch", message: SERVER_ENGLISH } }),
    ]);

    mount();

    await screen.findByRole("button", { name: "Terbitkan" });
    fireEvent.click(saveButton());

    expect(await screen.findByText(SESSION_MISMATCH_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(SERVER_ENGLISH)).toBeNull();
  });

  it("offers Terbitkan when the server is ready, and refuses it on the client's own checks alone", async () => {
    stubFetchSequence([() => loadOk(READY)]);

    mount();

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(publishButton().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(UNVERIFIED_REASON)).toBeNull();
    // The other half of A2's claim: the wording belongs to an ENABLED control, and this is the state
    // that is allowed to say it.
    expect(screen.getByText("Semua perubahan tersimpan dan siap diterbitkan")).toBeTruthy();
  });

  describe("a registration end that is already past", () => {
    const ORDERING_MESSAGE = "Pendaftaran berakhir harus setelah pendaftaran mulai.";

    // The three places the message can appear, read separately so that one rendering cannot be
    // mistaken for another.
    const registrationEndField = () => screen.getByLabelText(/Pendaftaran berakhir/);
    const registrationEndFieldError = () =>
      document.getElementById("registration-end-timeline-error");
    const statusLine = () => document.querySelector("#publish-readiness-message > span");

    const draftWithClosedWindow = () =>
      okJson({
        competition: { ...COMPETITION, ...closedRegistrationWindow() },
        publishReadiness: BLOCKED_BY_CHECKLIST,
      });

    const publishedWithClosedWindow = () =>
      okJson({
        competition: { ...COMPETITION, status: "published", ...closedRegistrationWindow() },
        publishReadiness: { canPublish: false, blockers: ["competition_invalid_transition"] },
      });

    it("flags the field on a draft, with the message as the field's own error", async () => {
      stubFetchSequence([draftWithClosedWindow]);

      mount();

      await screen.findByRole("button", { name: "Terbitkan" });
      await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));

      expect(registrationEndField().getAttribute("aria-invalid")).toBe("true");
      expect(registrationEndFieldError()?.textContent).toBe(REGISTRATION_END_PAST_MESSAGE);
    });

    it("says it in the status line on a draft", async () => {
      stubFetchSequence([draftWithClosedWindow]);

      mount();

      await screen.findByRole("button", { name: "Terbitkan" });
      await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));

      expect(statusLine()?.textContent).toBe(REGISTRATION_END_PAST_MESSAGE);
      // The client says what the server's generic sentence would have said, so that sentence is
      // dropped rather than shown beside a more specific one.
      expect(screen.queryByText(VALIDATION_REASON)).toBeNull();
      expect(screen.queryAllByText(/siap diterbitkan/)).toHaveLength(0);
    });

    it("blocks publishing a draft but not saving it", async () => {
      stubFetchSequence([draftWithClosedWindow]);

      mount();

      await screen.findByRole("button", { name: "Terbitkan" });
      await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));

      expect(saveButton().hasAttribute("disabled")).toBe(false);
    });

    it("shows none of the three on a published competition", async () => {
      stubFetchSequence([publishedWithClosedWindow]);

      mount();

      // A published competition has no Terbitkan control, so wait on its Simpan.
      await screen.findByRole("button", { name: "Simpan" });
      await waitFor(() =>
        expect(
          screen.getByText("Hanya kompetisi berstatus draf yang dapat diterbitkan."),
        ).toBeTruthy(),
      );

      expect(registrationEndField().getAttribute("aria-invalid")).toBeNull();
      expect(registrationEndFieldError()).toBeNull();
      expect(statusLine()?.textContent ?? "").not.toContain(REGISTRATION_END_PAST_MESSAGE);
      expect(screen.queryByText(REGISTRATION_END_PAST_MESSAGE)).toBeNull();
    });

    // The ordering error blocks saving as well, so it must read the same for every status and must
    // outrank the past-date message wherever both could apply.
    it("lets the ordering error take precedence on a draft", async () => {
      const now = Date.now();
      stubFetchSequence([
        () =>
          okJson({
            competition: {
              ...COMPETITION,
              registrationStartAt: new Date(now - 10 * DAY).toISOString(),
              registrationEndAt: new Date(now - 20 * DAY).toISOString(),
              participantConfirmationAt: new Date(now - 15 * DAY).toISOString(),
            },
            publishReadiness: BLOCKED_BY_CHECKLIST,
          }),
      ]);

      mount();

      await screen.findByRole("button", { name: "Terbitkan" });
      await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));

      expect(registrationEndFieldError()?.textContent).toBe(ORDERING_MESSAGE);
      expect(statusLine()?.textContent).toContain(ORDERING_MESSAGE);
      expect(screen.queryByText(REGISTRATION_END_PAST_MESSAGE)).toBeNull();
      expect(registrationEndField().getAttribute("aria-invalid")).toBe("true");
    });

    it("still flags an ordering error on a published competition", async () => {
      const now = Date.now();
      stubFetchSequence([
        () =>
          okJson({
            competition: {
              ...COMPETITION,
              status: "published",
              registrationStartAt: new Date(now + 10 * DAY).toISOString(),
              registrationEndAt: new Date(now + 5 * DAY).toISOString(),
              participantConfirmationAt: new Date(now + 20 * DAY).toISOString(),
            },
            publishReadiness: { canPublish: false, blockers: ["competition_invalid_transition"] },
          }),
      ]);

      mount();

      await screen.findByRole("button", { name: "Simpan" });
      await waitFor(() => expect(registrationEndFieldError()).not.toBeNull());

      expect(registrationEndFieldError()?.textContent).toBe(ORDERING_MESSAGE);
      expect(registrationEndField().getAttribute("aria-invalid")).toBe("true");
    });
  });

  it("shows a reason on a disabled Terbitkan that no client check can explain", async () => {
    stubFetchSequence([
      () =>
        okJson({
          competition: COMPETITION,
          publishReadiness: BLOCKED_BY_CHECKLIST,
        }),
    ]);

    mount();

    await screen.findByRole("button", { name: "Terbitkan" });
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));

    // The reason is the LOADED answer, not the readiness the page was rendered with.
    expect(screen.queryByText(UNVERIFIED_REASON)).toBeNull();
    expect(screen.getByText(VALIDATION_REASON)).toBeTruthy();

    // No link: this shell IS the page the link would point at.
    expect(screen.queryByRole("link", { name: "Buka halaman edit" })).toBeNull();

    // And nothing on screen claims the draft is ready while the control says it is not.
    expect(screen.queryAllByText(/siap diterbitkan/)).toHaveLength(0);
    expect(screen.queryAllByText(/Lengkapi untuk menerbitkan/)).toHaveLength(0);
  });

  it("clears the unknown state on a successful read that carries no readiness key", async () => {
    const calls = stubFetchSequence([
      () => loadOk(BLOCKED),
      () => patchOk,
      () => loadFailed,
      () => patchOk,
      () => loadOkWithoutReadiness,
    ]);

    mount();

    // 1. KNOWN-BLOCKED.
    await screen.findByRole("button", { name: "Terbitkan" });
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));

    // 2. UNKNOWN — a failed refetch disables nothing.
    fireEvent.click(saveButton());
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(false));

    // 3. KNOWN AGAIN — the read succeeded, so the shell stops treating its answer as unknown. Under
    // the latch this step left the control enabled forever: only a response carrying the optional
    // key could clear the flag, so a key-less success was indistinguishable from a failure.
    fireEvent.click(saveButton());
    // Waits on the reason, not on `disabled`: Terbitkan is also disabled while the save is in
    // flight, before the refetch that restores the refusal has landed.
    expect(await screen.findByText(UNVERIFIED_REASON)).toBeTruthy();
    expect(publishButton().hasAttribute("disabled")).toBe(true);

    expect(calls).toEqual([
      "GET /api/v1/competitions/comp_1",
      "PATCH /api/v1/competitions/comp_1",
      "GET /api/v1/competitions/comp_1",
      "PATCH /api/v1/competitions/comp_1",
      "GET /api/v1/competitions/comp_1",
    ]);
  });
});

describe("InstitutionCompetitionEditShell steps", () => {
  const STEP_TITLES = {
    1: "Informasi dasar",
    2: "Peserta",
    3: "Jadwal",
    4: "Hadiah dan biaya",
    5: "Tinjau dan terbitkan",
  } as const;
  const SECTION_HEADINGS_BY_STEP = {
    1: ["Informasi utama"],
    2: ["Mode dan ukuran tim", "Minimum peserta"],
    3: ["Jadwal kompetisi", "Minimum peserta"],
    4: ["Kebijakan pembatalan peserta"],
  } as const;
  const ALL_SECTION_HEADINGS = [
    "Informasi utama",
    "Mode dan ukuran tim",
    "Jadwal kompetisi",
    "Minimum peserta",
    "Kebijakan pembatalan peserta",
  ];
  const STEP_FIELD_LABELS = {
    1: ["Judul", "Kategori", "Deskripsi", "Slug"],
    2: ["Mode", "Min. anggota tim", "Maks. anggota tim", "Minimum pendaftaran"],
    3: [
      "Pendaftaran mulai",
      "Pendaftaran berakhir",
      "Acara mulai",
      "Acara berakhir",
      "Pengumuman hasil",
      "Konfirmasi peserta",
    ],
    4: ["Batas pembatalan (hari sebelum acara mulai)"],
  } as const;
  const STEP_CHILD_TEXT = {
    1: "Sub-editor langkah 1",
    2: "Sub-editor langkah 2",
    3: "Sub-editor langkah 3",
    4: "Sub-editor langkah 4",
  } as const;
  const ALL_CHILDREN_TEXT = "Semua sub-editor";
  const EDIT_URL = "/institution/institusi-contoh/competitions/lomba-contoh-2026/edit";
  const LIST_URL = "/institution/institusi-contoh/competitions";

  const shellAt = (step: 1 | 2 | 3 | 4 | 5 | null) => (
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <InstitutionCompetitionEditShell
          institutionSlug="institusi-contoh"
          competitionId="comp_1"
          expectedUserId="org_1"
          initialPublishReadiness={{ canPublish: true, blockers: [] }}
          step={step}
          stepChildren={{
            1: <p>{STEP_CHILD_TEXT[1]}</p>,
            2: <p>{STEP_CHILD_TEXT[2]}</p>,
            3: <p>{STEP_CHILD_TEXT[3]}</p>,
            4: <p>{STEP_CHILD_TEXT[4]}</p>,
          }}
        >
          <p>{ALL_CHILDREN_TEXT}</p>
        </InstitutionCompetitionEditShell>
      </PageTransitionProvider>
    </UIPrimitivesProvider>
  );

  const indicatorLine = () => document.querySelector(".step-indicator-text")?.textContent;
  const sectionHeadings = () =>
    screen.queryAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  const fieldLabels = () =>
    [...document.querySelectorAll(".competition-edit-form .form-label")].map(
      (label) => label.textContent,
    );
  const readinessNote = () => document.getElementById("publish-readiness-message");
  const sectionNav = () => screen.getByRole("navigation", { name: "Bagian kompetisi" });
  const summaryTerms = () =>
    [...document.querySelectorAll(".management-detail-grid dt")].map((term) => term.textContent);
  const summaryValue = (term: string) => {
    const terms = [...document.querySelectorAll(".management-detail-grid dt")].filter(
      (element) => element.textContent === term,
    );
    expect(terms, term).toHaveLength(1);
    return terms[0]?.nextElementSibling?.textContent;
  };
  const patchBodies = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);
  const minuteDate = (iso: string) => {
    const date = new Date(iso);
    date.setSeconds(0, 0);
    return date.toISOString();
  };
  const toLocalInput = (date: Date) => {
    const local = new Date(date);
    local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
    return local.toISOString().slice(0, 16);
  };
  const failingRequest = (): Response => {
    throw new TypeError("Failed to fetch");
  };
  const transitionMessage = (message: string) =>
    document.querySelector(".page-transition-message")?.textContent === message;

  // Records any rejection nothing handled, so a test can assert that a failed request stays inside
  // the shell instead of escaping from a click handler.
  const watchUnhandledRejections = () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    return {
      unhandled,
      stop: () => process.off("unhandledRejection", unhandled),
    };
  };

  it.each([1, 2, 3, 4] as const)("renders only the blocks of step %i", async (step) => {
    stubFetchSequence([() => loadOk(READY)]);

    render(shellAt(step));

    await screen.findByRole("button", { name: "Lanjut" });
    expect(indicatorLine()).toBe(`Langkah ${step} dari 5: ${STEP_TITLES[step]}`);
    const expectedHeadings: readonly string[] = SECTION_HEADINGS_BY_STEP[step];
    for (const heading of ALL_SECTION_HEADINGS) {
      expect(sectionHeadings().includes(heading), heading).toBe(expectedHeadings.includes(heading));
    }
    expect(fieldLabels()).toEqual(STEP_FIELD_LABELS[step]);
    for (const childStep of [1, 2, 3, 4] as const) {
      const shown = screen.queryByText(STEP_CHILD_TEXT[childStep]) !== null;
      expect(shown, `child of step ${childStep}`).toBe(childStep === step);
    }
    expect(screen.queryByText(ALL_CHILDREN_TEXT)).toBeNull();
  });

  it.each([1, 2, 3, 4] as const)("shows the step bar on step %i", async (step) => {
    stubFetchSequence([() => loadOk(READY)]);

    render(shellAt(step));

    const next = await screen.findByRole("button", { name: "Lanjut" });
    const saveAndExit = screen.getByRole("button", { name: "Simpan dan keluar" });
    const backLabel = step === 1 ? "Kembali ke daftar kompetisi" : "Kembali";
    expect(screen.getByRole("button", { name: backLabel })).toBeTruthy();
    expect(next.getAttribute("data-variant")).toBe("primary");
    expect(saveAndExit.getAttribute("data-variant")).toBe("outline");
    expect(screen.queryByRole("button", { name: "Simpan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terbitkan" })).toBeNull();
    expect(readinessNote()?.textContent).toContain(
      "Semua perubahan tersimpan dan siap diterbitkan",
    );
  });

  it("shows step 5 with its summary and its own bar", async () => {
    stubFetchSequence([() => loadOk(READY)]);

    render(shellAt(5));

    const publish = await screen.findByRole("button", { name: "Terbitkan" });
    expect(indicatorLine()).toBe("Langkah 5 dari 5: Tinjau dan terbitkan");
    expect(sectionHeadings()).toEqual([
      STEP_TITLES[1],
      STEP_TITLES[2],
      STEP_TITLES[3],
      STEP_TITLES[4],
    ]);
    expect(fieldLabels()).toEqual([]);
    for (const text of [...Object.values(STEP_CHILD_TEXT), ALL_CHILDREN_TEXT]) {
      expect(screen.queryByText(text), text).toBeNull();
    }
    expect(publish.getAttribute("data-variant")).toBe("primary");
    expect(publish.hasAttribute("disabled")).toBe(false);
    const exit = screen.getByRole("link", { name: "Keluar" });
    expect(exit.getAttribute("href")).toBe(LIST_URL);
    expect(exit.getAttribute("data-variant")).toBe("ghost");
    expect(screen.getByRole("button", { name: "Kembali" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lanjut" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simpan dan keluar" })).toBeNull();
    expect(readinessNote()).not.toBeNull();
  });

  it("opens a section of a published competition opened at a step", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(2));

    await screen.findByRole("button", { name: "Simpan" });
    expect(indicatorLine()).toBeUndefined();
    const links = within(sectionNav()).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      STEP_TITLES[1],
      STEP_TITLES[2],
      STEP_TITLES[3],
      STEP_TITLES[4],
    ]);
    links.forEach((link, index) => {
      const isCurrent = index === 1;
      expect(link.getAttribute("href")).toBe(`${EDIT_URL}?langkah=${index + 1}`);
      expect(link.getAttribute("aria-current")).toBe(isCurrent ? "page" : null);
      expect(link.getAttribute("data-variant")).toBe(isCurrent ? "primary" : "outline");
      expect(link.getAttribute("data-size")).toBe("sm");
    });
    const expectedHeadings: readonly string[] = SECTION_HEADINGS_BY_STEP[2];
    for (const heading of ALL_SECTION_HEADINGS) {
      expect(sectionHeadings().includes(heading), heading).toBe(expectedHeadings.includes(heading));
    }
    expect(fieldLabels()).toEqual(STEP_FIELD_LABELS[2]);
    for (const childStep of [1, 2, 3, 4] as const) {
      const shown = screen.queryByText(STEP_CHILD_TEXT[childStep]) !== null;
      expect(shown, `child of step ${childStep}`).toBe(childStep === 2);
    }
    expect(screen.queryByText(ALL_CHILDREN_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: "Kembali ke aksi status" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Terbitkan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lanjut" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simpan dan keluar" })).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("covers Lanjut with the transition screen until the next step arrives", async () => {
    stubFetchSequence([() => loadOk(READY), () => patchOk, () => loadOk(READY)]);

    const view = render(shellAt(1));

    fireEvent.click(await screen.findByRole("button", { name: "Lanjut" }));
    expect(transitionMessage("Menyimpan kompetisi…")).toBe(true);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`${EDIT_URL}?langkah=2`));
    expect(transitionMessage("Menyimpan kompetisi…")).toBe(true);

    view.rerender(shellAt(2));

    await waitFor(() => expect(document.querySelector(".page-transition")).toBeNull());
  });

  it.each(["Lanjut", "Simpan dan keluar"])(
    "keeps the user on the step when the request behind %s throws",
    async (action) => {
      const watcher = watchUnhandledRejections();
      try {
        stubFetchSequence([() => loadOk(READY), failingRequest]);

        render(shellAt(2));

        fireEvent.click(await screen.findByRole("button", { name: action }));

        expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeTruthy();
        await waitFor(() => expect(document.querySelector(".page-transition")).toBeNull());
        for (const name of ["Lanjut", "Simpan dan keluar"]) {
          const button = screen.getByRole("button", { name });
          expect(button.hasAttribute("disabled"), name).toBe(false);
          expect(button.hasAttribute("aria-busy"), name).toBe(false);
        }
        expect(mockPush).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(watcher.unhandled).not.toHaveBeenCalled();
      } finally {
        watcher.stop();
      }
    },
  );

  it("opens a draft without a step at the step it should resume at", async () => {
    // A team draft with no team size resumes at step 2.
    const competition = { ...COMPETITION, mode: "team", minTeamSize: null, maxTeamSize: null };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(null));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`${EDIT_URL}?langkah=2`));
    expect(screen.getByLabelText("Memuat formulir kompetisi")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
    for (const text of [...Object.values(STEP_CHILD_TEXT), ALL_CHILDREN_TEXT]) {
      expect(screen.queryByText(text), text).toBeNull();
    }
  });

  it("sends a published competition opened without a step to section 1", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(null));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`${EDIT_URL}?langkah=1`));
    expect(screen.getByLabelText("Memuat formulir kompetisi")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
    for (const text of [...Object.values(STEP_CHILD_TEXT), ALL_CHILDREN_TEXT]) {
      expect(screen.queryByText(text), text).toBeNull();
    }
  });

  it("sends a published competition opened at step 5 to section 1", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(5));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`${EDIT_URL}?langkah=1`));
    expect(screen.getByLabelText("Memuat formulir kompetisi")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Terbitkan" })).toBeNull();
  });

  it("drops an unsaved value of another step when the step changes", async () => {
    stubFetchSequence([() => loadOk(READY), () => patchOk, () => loadOk(READY)]);

    const view = render(shellAt(3));

    await screen.findByRole("button", { name: "Lanjut" });
    const later = new Date(COMPETITION.resultAnnouncementAt);
    later.setDate(later.getDate() + 3);
    fireEvent.change(screen.getByLabelText(/Pengumuman hasil/), {
      target: { value: toLocalInput(later) },
    });

    view.rerender(shellAt(2));
    fireEvent.click(await screen.findByRole("button", { name: "Lanjut" }));

    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]?.resultAnnouncementAt).toBe(
      minuteDate(COMPETITION.resultAnnouncementAt),
    );
  });

  it("keeps a value saved on one step when the reload after it is refused", async () => {
    stubFetchSequence([
      () => loadOk(READY),
      () => patchOk,
      () => loadFailed,
      () => patchOk,
      () => loadOk(READY),
    ]);

    const view = render(shellAt(2));

    await screen.findByRole("button", { name: "Lanjut" });
    fireEvent.change(screen.getByLabelText(/Minimum pendaftaran/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`${EDIT_URL}?langkah=3`));
    expect(await screen.findByText(LOAD_FAILED_MESSAGE)).toBeTruthy();

    view.rerender(shellAt(3));
    fireEvent.click(await screen.findByRole("button", { name: "Lanjut" }));

    await waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[0]?.minimumParticipantEntries).toBe(5);
    expect(patchBodies()[1]?.minimumParticipantEntries).toBe(5);
  });

  it("does not open step 5 with the unsaved changes of step 4", async () => {
    stubFetchSequence([() => loadOk(READY)]);

    const view = render(shellAt(4));

    await screen.findByRole("button", { name: "Lanjut" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Izinkan peserta membatalkan pendaftaran sendiri" }),
    );
    expect(readinessNote()?.textContent).toContain("Simpan perubahan sebelum menerbitkan");

    view.rerender(shellAt(5));

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(readinessNote()).not.toBeNull();
    expect(readinessNote()?.textContent).not.toContain("Simpan perubahan sebelum menerbitkan");
  });

  it("opens the next step at the slug step 1 just saved", async () => {
    stubFetchSequence([() => loadOk(READY), () => patchOk, () => loadOk(READY)]);

    render(shellAt(1));

    await screen.findByRole("button", { name: "Lanjut" });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "lomba-baru" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        "/institution/institusi-contoh/competitions/lomba-baru/edit?langkah=2",
      ),
    );
    expect(patchBodies()[0]?.slug).toBe("lomba-baru");
  });

  it("sums up each step of a draft on step 5 with a link to edit it", async () => {
    const competition = {
      ...COMPETITION,
      description: "a".repeat(250),
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
      minimumParticipantEntries: 1500,
      registrationStartAt: new Date(2026, 11, 1, 9, 0).toISOString(),
      resultAnnouncementAt: null,
      allowCancellation: true,
      cancellationCutoffDays: 3,
    };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(5));

    await screen.findByRole("button", { name: "Terbitkan" });
    const editLabels = [
      "Edit informasi dasar",
      "Edit peserta",
      "Edit jadwal",
      "Edit hadiah dan biaya",
    ];
    editLabels.forEach((label, index) => {
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(`${EDIT_URL}?langkah=${index + 1}`);
      expect(link.getAttribute("data-variant")).toBe("outline");
      expect(link.getAttribute("data-size")).toBe("sm");
    });
    expect(summaryValue("Judul")).toBe(COMPETITION.title);
    expect(summaryValue("Kategori")).toBe("Hackathon");
    expect(summaryValue("Deskripsi")).toBe("a".repeat(250));
    expect(summaryValue("Slug")).toBe(COMPETITION.slug);
    expect(summaryValue("Mode")).toBe("Tim");
    expect(summaryValue("Min. anggota tim")).toBe("2");
    expect(summaryValue("Maks. anggota tim")).toBe("4");
    expect(summaryValue("Minimum pendaftaran")).toBe("1.500");
    expect(summaryValue("Pendaftaran mulai")).toBe("2026-12-01 09:00");
    expect(summaryValue("Pengumuman hasil")).toBe("—");
    expect(summaryValue("Pembatalan oleh peserta")).toBe("Diizinkan");
    expect(summaryValue("Batas pembatalan")).toBe("3 hari sebelum acara mulai");
    expect(summaryTerms()).toEqual([
      "Judul",
      "Kategori",
      "Deskripsi",
      "Slug",
      "Mode",
      "Min. anggota tim",
      "Maks. anggota tim",
      "Minimum pendaftaran",
      "Pendaftaran mulai",
      "Pendaftaran berakhir",
      "Acara mulai",
      "Acara berakhir",
      "Pengumuman hasil",
      "Konfirmasi peserta",
      "Pembatalan oleh peserta",
      "Batas pembatalan",
    ]);
  });

  it("shows the whole description on a row of its own", async () => {
    const competition = { ...COMPETITION, description: "Baris satu\nBaris dua" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(5));

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(summaryValue("Deskripsi")).toBe("Baris satu\nBaris dua");
    expect(
      screen
        .getByText("Deskripsi", { selector: "dt" })
        .parentElement?.classList.contains("management-detail-wide"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Lihat selengkapnya" })).toBeNull();
  });

  it("offers Lihat selengkapnya when the description runs past three lines, and folds it back", async () => {
    const competition = {
      ...COMPETITION,
      description: "Baris satu\nBaris dua\nBaris tiga\nBaris empat",
    };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);
    const scrollHeight = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(120);
    const clientHeight = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(60);

    try {
      render(shellAt(5));

      const more = await screen.findByRole("button", { name: "Lihat selengkapnya" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      const text = document.getElementById(more.getAttribute("aria-controls") ?? "");
      expect(text?.textContent).toBe("Baris satu\nBaris dua\nBaris tiga\nBaris empat");
      expect(text?.getAttribute("data-expanded")).toBe("false");
      fireEvent.click(more);
      const less = screen.getByRole("button", { name: "Tampilkan lebih sedikit" });
      expect(less.getAttribute("aria-expanded")).toBe("true");
      expect(text?.getAttribute("data-expanded")).toBe("true");
      fireEvent.click(less);
      expect(
        screen.getByRole("button", { name: "Lihat selengkapnya" }).getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it("shows a dash and no button for an empty description", async () => {
    const competition = { ...COMPETITION, description: "" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(5));

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(summaryValue("Deskripsi")).toBe("—");
    expect(screen.queryByRole("button", { name: "Lihat selengkapnya" })).toBeNull();
  });

  it.each([
    ["individual", false],
    ["team", true],
    ["both", true],
  ])("shows the team size rows on step 5 for mode %s: %s", async (mode, showsTeamRows) => {
    const competition = { ...COMPETITION, mode, minTeamSize: 1, maxTeamSize: 3 };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(5));

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(summaryTerms().includes("Min. anggota tim")).toBe(showsTeamRows);
    expect(summaryTerms().includes("Maks. anggota tim")).toBe(showsTeamRows);
  });

  it("shows no cutoff on step 5 when participants may not cancel", async () => {
    stubFetchSequence([() => loadOk(READY)]);

    render(shellAt(5));

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(summaryValue("Pembatalan oleh peserta")).toBe("Tidak diizinkan");
    expect(summaryTerms().includes("Batas pembatalan")).toBe(false);
  });

  it("asks before another section opens with unsaved changes", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    const view = render(shellAt(1));

    await screen.findByRole("button", { name: "Simpan" });
    fireEvent.change(screen.getByLabelText(/^Judul/), { target: { value: "Lomba Contoh Baru" } });
    const notPrevented = fireEvent.click(
      within(sectionNav()).getByRole("link", { name: "Jadwal" }),
    );

    expect(notPrevented).toBe(false);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Perubahan belum tersimpan")).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Tinggalkan" }));

    expect(transitionMessage("Membuka bagian kompetisi…")).toBe(true);
    expect(mockPush).toHaveBeenCalledWith(`${EDIT_URL}?langkah=3`);

    view.rerender(shellAt(3));

    await waitFor(() => expect(document.querySelector(".page-transition")).toBeNull());
    fireEvent.click(saveButton());
    expect(await screen.findByText("Perubahan tersimpan.")).toBeTruthy();
    expect(patchBodies()).toEqual([]);
  });

  it("saves a published section on Enter and stays on it", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([
      () => okJson({ competition, publishReadiness: READY }),
      () => okJson({ competition }),
      () => okJson({ competition, publishReadiness: READY }),
    ]);

    render(shellAt(1));

    await screen.findByRole("button", { name: "Simpan" });
    fireEvent.change(screen.getByLabelText(/^Judul/), { target: { value: "Lomba Contoh Baru" } });
    fireEvent.submit(document.querySelector(".competition-edit-form")!);

    expect(await screen.findByText("Perubahan tersimpan.")).toBeTruthy();
    expect(patchBodies()).toEqual([{ title: "Lomba Contoh Baru" }]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("opens another section as a plain link without unsaved changes", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(1));

    await screen.findByRole("button", { name: "Simpan" });
    const notPrevented = fireEvent.click(
      within(sectionNav()).getByRole("link", { name: "Jadwal" }),
    );

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".page-transition")).toBeNull();
  });

  it("asks nothing when the current section is pressed with unsaved changes", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(1));

    await screen.findByRole("button", { name: "Simpan" });
    fireEvent.change(screen.getByLabelText(/^Judul/), { target: { value: "Lomba Contoh Baru" } });
    const current = within(sectionNav()).getByRole("link", { name: STEP_TITLES[1] });
    const notPrevented = fireEvent.click(current);

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the status actions from the back control of every published section", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    const view = render(shellAt(1));

    await screen.findByRole("button", { name: "Simpan" });
    for (const section of [1, 2, 3, 4] as const) {
      view.rerender(shellAt(section));
      fireEvent.click(screen.getByRole("button", { name: "Kembali ke aksi status" }));
      expect(mockPush).toHaveBeenLastCalledWith(
        "/institution/institusi-contoh/competitions/lomba-contoh-2026",
      );
    }
    expect(mockPush).toHaveBeenCalledTimes(4);
  });

  it("names the published sentence before the confirmation help in published section 3", async () => {
    const competition = { ...COMPETITION, status: "published" };
    stubFetchSequence([() => okJson({ competition, publishReadiness: READY })]);

    render(shellAt(3));

    await screen.findByRole("button", { name: "Simpan" });
    const publishedSentence = document.getElementById("minimum-participation-help");
    expect(publishedSentence?.textContent).toBe(
      "Minimum peserta dan waktu konfirmasi tidak dapat diubah setelah kompetisi terbit.",
    );
    const confirmation = screen.getByLabelText(/Konfirmasi peserta/);
    expect(confirmation.getAttribute("aria-describedby")).toBe(
      "minimum-participation-help participant-confirmation-help",
    );

    const afterConfirmation = new Date(COMPETITION.participantConfirmationAt);
    afterConfirmation.setDate(afterConfirmation.getDate() + 5);
    fireEvent.change(screen.getByLabelText(/Pendaftaran berakhir/), {
      target: { value: toLocalInput(afterConfirmation) },
    });

    expect(document.getElementById("participant-confirmation-timeline-error")).not.toBeNull();
    expect(confirmation.getAttribute("aria-describedby")).toBe(
      "minimum-participation-help participant-confirmation-help participant-confirmation-timeline-error",
    );
  });

  it("runs Lanjut when a step form is submitted", async () => {
    const competition = { ...COMPETITION, allowCancellation: true, cancellationCutoffDays: 3 };
    stubFetchSequence([
      () => okJson({ competition, publishReadiness: READY }),
      () => okJson({ competition }),
      () => okJson({ competition, publishReadiness: READY }),
    ]);

    render(shellAt(4));

    await screen.findByRole("button", { name: "Lanjut" });
    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`${EDIT_URL}?langkah=5`));
    expect(patchBodies()).toHaveLength(1);
  });

  it("publishes from step 5 and opens the management page", async () => {
    const calls = stubFetchSequence([() => loadOk(READY), () => okJson({})]);

    render(shellAt(5));

    fireEvent.click(await screen.findByRole("button", { name: "Terbitkan" }));

    expect(await screen.findByText("Kompetisi diterbitkan.")).toBeTruthy();
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        "/institution/institusi-contoh/competitions/lomba-contoh-2026",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      "GET /api/v1/competitions/comp_1",
      "POST /api/v1/institutions/institusi-contoh/competitions/comp_1/publish",
    ]);
  });
});
