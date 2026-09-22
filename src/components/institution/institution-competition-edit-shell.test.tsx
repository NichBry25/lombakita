// @vitest-environment jsdom
//
// WHAT THIS FILE EXISTS TO PIN (C2.2, F5): a readiness answer the shell could not REFRESH must not
// keep the publish control disabled. The server is still the authority — pressing Terbitkan sends
// the attempt, and a refusal comes back as Indonesian text through `competition-publish-messages` —
// so an unknown answer disables nothing and prints no reason. A reason is a claim about what the
// server will do, and after a failed read the shell has just admitted it does not know.
//
// The SECOND save is what makes this test able to fail. A single failed refetch proves only that the
// control is enabled afterwards; it is satisfied by an implementation that never becomes ready
// again, which would leave the reason permanently unreachable. The sequence therefore runs
// known-blocked → unknown → known-blocked and asserts each state.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const LOAD_FAILED_MESSAGE = "Gagal memuat kompetisi.";

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const failedJson = (body: unknown): Response =>
  ({ ok: false, json: async () => body }) as unknown as Response;

const loadOk = (publishReadiness: unknown) =>
  okJson({ competition: COMPETITION, publishReadiness });
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

  it("offers Terbitkan when the server is ready, and refuses it on the client's own checks alone", async () => {
    stubFetchSequence([() => loadOk(READY)]);

    mount();

    await screen.findByRole("button", { name: "Terbitkan" });
    expect(publishButton().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(UNVERIFIED_REASON)).toBeNull();
  });
});
