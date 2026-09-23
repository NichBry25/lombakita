// @vitest-environment jsdom
//
// WHAT THIS FILE EXISTS TO PIN (C2.2, A3): a readiness answer the detail shell could not REFRESH must
// not keep Terbitkan disabled. The edit shell got this rule at F5; this shell asked the same server
// question and never learned it, so a failed refetch left the last answer standing and the control
// disabled on a reason nobody had been shown.
//
// WHY THE SEQUENCE IS DRIVEN BY "Batalkan kompetisi" RATHER THAN BY Terbitkan. The refetch this test
// has to fail runs after a successful lifecycle action, and the only other readiness-gated control on
// a draft is Terbitkan itself — which is DISABLED while the readiness is blocked, by the very rule
// under test. A blocked draft therefore has no clickable path to a refetch except the participation
// decision, whose buttons are gated on the competition's minimum-participant state and not on
// readiness.
//
// The sequence is known-blocked → unknown → known-blocked, and the MIDDLE state is what makes the
// test able to fail: the readiness held at that moment is BLOCKED, so an implementation that ignored
// `readinessIsKnown` would leave the control disabled with the reason still on screen.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { InstitutionCompetitionDetailShell } from "./institution-competition-detail-shell";

// PageTransitionProvider reads the pathname; the shell reads the router for its post-delete refresh.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/institution/institusi-contoh/competitions/comp_1",
}));

const DAY = 24 * 60 * 60 * 1000;
const now = () => Date.now();

const COMPETITION = {
  id: "comp_1",
  institutionId: "inst_1",
  slug: "lomba-contoh-2026",
  title: "Lomba Contoh 2026",
  description: "Deskripsi kompetisi untuk pengujian.",
  status: "draft",
  category: "hackathon",
  mode: "individual",
  registrationStartAt: new Date(now() - 30 * DAY).toISOString(),
  registrationEndAt: new Date(now() - 20 * DAY).toISOString(),
  eventStartAt: new Date(now() + 10 * DAY).toISOString(),
  eventEndAt: new Date(now() + 11 * DAY).toISOString(),
  resultAnnouncementAt: new Date(now() + 20 * DAY).toISOString(),
  // The participation section is what carries the only control that can drive a refetch from a
  // blocked draft, so the fixture has a minimum-participant rule.
  minimumParticipantEntries: 1,
  participantConfirmationAt: new Date(now() - DAY).toISOString(),
  participationConfirmedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  publishedAt: null,
};

const PARTICIPATION = {
  minimumParticipantEntries: 1,
  participantConfirmationAt: new Date(now() - DAY).toISOString(),
  participationConfirmedAt: null,
  participantEntryCount: 0,
  state: "decision_due" as const,
  canCancel: true,
  canConfirmProceed: false,
};

const BLOCKED = {
  canPublish: false,
  blockers: ["competition_institution_not_verified" as const],
};

// The exact sentence `competition-publish-messages.ts` renders for that code.
const UNVERIFIED_REASON =
  "Kompetisi berbayar hanya dapat diterbitkan oleh institusi yang sudah terverifikasi.";
const LOAD_FAILED_MESSAGE = "Gagal memuat kompetisi.";

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const loadOk = (publishReadiness: unknown) =>
  okJson({
    competition: COMPETITION,
    hasActiveRegistrations: true,
    participation: PARTICIPATION,
    publishReadiness,
  });
const decisionOk = okJson({ participation: PARTICIPATION });
const loadFailed = {
  ok: false,
  json: async () => ({ error: { message: LOAD_FAILED_MESSAGE } }),
} as unknown as Response;

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
        <InstitutionCompetitionDetailShell
          institutionSlug="institusi-contoh"
          competitionId="comp_1"
          expectedUserId="org_1"
          initialPublishReadiness={BLOCKED}
          canDecideParticipation
        />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const publishButton = () => screen.getByRole("button", { name: "Terbitkan" });
const cancelButton = () => screen.getByRole("button", { name: "Batalkan" });

// The participation decision is behind a confirmation modal, and the page control and the modal's
// confirm action carry the SAME label ("Batalkan") — so the dialog is scoped rather than the label
// assumed unique. The count assertion is what makes the scoping honest: it fails if the first click
// did not open a dialog, instead of silently clicking the wrong control.
const decideToCancel = async () => {
  const label = "Batalkan";
  const controls = screen.getAllByRole("button", { name: label });
  expect(controls, "expected exactly one closed-dialog control").toHaveLength(1);
  fireEvent.click(controls[0]!);

  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
};

describe("InstitutionCompetitionDetailShell publish readiness", () => {
  it("drops a server refusal it could not refresh, and takes it back when a later read succeeds", async () => {
    const calls = stubFetchSequence([
      () => loadOk(BLOCKED),
      () => decisionOk,
      () => loadFailed,
      () => decisionOk,
      () => loadOk(BLOCKED),
    ]);

    mount();

    // 1. KNOWN-BLOCKED. The server refused; the control says so and prints the server's reason.
    await screen.findByRole("button", { name: "Terbitkan" });
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(UNVERIFIED_REASON)).toBeTruthy();

    // 2. UNKNOWN. A lifecycle action succeeds and the refetch behind it fails. The readiness that
    // provoked this must go with it: Terbitkan is offered again and no reason is shown. The error
    // toast is what tells the user the read failed.
    await decideToCancel();

    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(UNVERIFIED_REASON)).toBeNull();
    expect(await screen.findByText(LOAD_FAILED_MESSAGE)).toBeTruthy();

    // 3. KNOWN-BLOCKED AGAIN. A second action whose refetch succeeds restores the refusal, which is
    // what proves the unknown state is not sticky.
    await decideToCancel();

    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(UNVERIFIED_REASON)).toBeTruthy();

    expect(calls).toEqual([
      "GET /api/v1/competitions/comp_1",
      "POST /api/v1/institutions/institusi-contoh/competitions/comp_1/participation-decision",
      "GET /api/v1/competitions/comp_1",
      "POST /api/v1/institutions/institusi-contoh/competitions/comp_1/participation-decision",
      "GET /api/v1/competitions/comp_1",
    ]);
  });

  it("keeps the control disabled and the reason visible while the server still refuses", async () => {
    stubFetchSequence([() => loadOk(BLOCKED)]);

    mount();

    await screen.findByRole("button", { name: "Terbitkan" });
    await waitFor(() => expect(publishButton().hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(UNVERIFIED_REASON)).toBeTruthy();
  });
});
