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
// A2: a DISABLED Terbitkan must always carry a visible reason. The client's own checks and the
// server's checklist overlap on missing fields and out-of-order dates and nowhere else — the server
// also refuses a registration window that has CLOSED (competition-core.ts:877-883), a fact neither
// client validator can see. So the server's checklist reason is dropped only when the shell is
// already saying the same thing about this form.
//
// A6: a successful read clears the unknown state even when the response omits the optional
// `publishReadiness` key.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SESSION_MISMATCH_MESSAGE } from "@/lib/session/session-fetch";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { InstitutionCompetitionEditShell } from "./institution-competition-edit-shell";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

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
const LOAD_FAILED_MESSAGE = "Gagal memuat kompetisi.";

const BLOCKED_BY_CHECKLIST = {
  canPublish: false,
  blockers: ["competition_publish_validation_failed" as const],
};

// The same competition with its registration window CLOSED and its ordering still valid. Every client
// check passes on this row: `getMissingCompetitionPublishFields` reads presence only, and
// `validateCompetitionTimeline` compares fields to each other and never to the clock. Only the
// server's checklist judges the clock, which is what makes this the shape the shell cannot explain
// on its own.
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
const loadFailed = failedJson({ error: { message: LOAD_FAILED_MESSAGE } });

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
      <InstitutionCompetitionEditShell
        institutionSlug="institusi-contoh"
        competitionId="comp_1"
        expectedUserId="org_1"
        initialPublishReadiness={BLOCKED}
      />
    </UIPrimitivesProvider>,
  );

const publishButton = () => screen.getByRole("button", { name: "Terbitkan" });
const saveButton = () => screen.getByRole("button", { name: "Simpan" });

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

    // 3. KNOWN-BLOCKED AGAIN. A second save whose refetch succeeds restores the refusal, which is
    // what proves the unknown state is not sticky.
    fireEvent.click(saveButton());

    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(UNVERIFIED_REASON)).toBeTruthy();

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

  it("shows a reason on a disabled Terbitkan that no client check can explain", async () => {
    stubFetchSequence([
      () =>
        okJson({
          competition: { ...COMPETITION, ...closedRegistrationWindow() },
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
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(UNVERIFIED_REASON)).toBeTruthy();

    expect(calls).toEqual([
      "GET /api/v1/competitions/comp_1",
      "PATCH /api/v1/competitions/comp_1",
      "GET /api/v1/competitions/comp_1",
      "PATCH /api/v1/competitions/comp_1",
      "GET /api/v1/competitions/comp_1",
    ]);
  });
});
