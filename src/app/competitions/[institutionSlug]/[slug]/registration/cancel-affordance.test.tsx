// @vitest-environment jsdom
//
// DEC-0131's cancel affordance is WITHHELD, and this is the only place that can prove it.
//
// `ui-states` reads rendered text and the browser audits measure geometry, so neither can tell a
// withheld control from a disabled one — a disabled "Batalkan pendaftaran" still renders those
// words. The distinction is the whole ruling: a control that appears and then refuses teaches a
// candidate the platform is broken, a control that is absent next to a sentence teaches them the
// rule. So each case is asserted in BOTH directions: the control is present when the predicate is
// false, and ABSENT — not merely disabled — when it is true.
//
// The predicate itself is a database question and is proven against a real Postgres in the
// manual-lane integration suite. What is proven here is that the answer reaches the screen.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { IndividualRegistrationSection } from "./individual-section";
import { CompetitionTeamSection } from "./team-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const CANCEL_LABEL = "Batalkan pendaftaran";
const TEAM_CANCEL_LABEL = "Batalkan pendaftaran tim";
const WITHHELD_COPY = /tidak dapat dibatalkan sendiri setelah bukti transfer dikirim/i;

const renderIndividual = (cancellationClosedByPaymentProof: boolean) =>
  render(
    <UIPrimitivesProvider>
      <IndividualRegistrationSection
        competitionId="comp-1"
        ctaState="open"
        initialRegistration={{ id: "reg-1", status: "confirmed" }}
        expectedUserId="user-1"
        modeLabel="Daftar"
        cancellationClosedByPaymentProof={cancellationClosedByPaymentProof}
      />
    </UIPrimitivesProvider>,
  );

const CAPTAIN = "user-captain";

const renderTeam = (
  cancellationClosedByPaymentProof: boolean,
  { viewerId = CAPTAIN, status = "submitted" as "submitted" | "forming" } = {},
) =>
  render(
    <UIPrimitivesProvider>
      <CompetitionTeamSection
        competitionId="comp-1"
        competitionMode="team"
        minTeamSize={2}
        maxTeamSize={4}
        registrationOpen
        expectedUserId={viewerId}
        initialTeam={{ id: "team-1", name: "Tim Uji", captainId: CAPTAIN, status }}
        initialMembers={[
          {
            membershipId: "m-1",
            userId: CAPTAIN,
            role: "captain",
            displayName: "Kapten",
            email: "kapten@example.com",
          },
          {
            membershipId: "m-2",
            userId: "user-member",
            role: "member",
            displayName: "Anggota",
            email: "anggota@example.com",
          },
        ]}
        initialPendingInvitations={[]}
        cancellationClosedByPaymentProof={cancellationClosedByPaymentProof}
      />
    </UIPrimitivesProvider>,
  );

describe("the individual cancel affordance", () => {
  it("OFFERS the control when no bukti transfer has been submitted", () => {
    renderIndividual(false);

    expect(screen.getByRole("button", { name: CANCEL_LABEL })).toBeTruthy();
    expect(screen.queryByText(WITHHELD_COPY)).toBeNull();
  });

  it("WITHHOLDS the control once a bukti transfer exists, and says why", () => {
    renderIndividual(true);

    // `queryByRole` with no name filter, so a control rendered DISABLED still fails this. Asserting
    // on `disabled` would pass for a button that was never supposed to be on the page.
    expect(screen.queryByRole("button", { name: CANCEL_LABEL })).toBeNull();
    expect(screen.getAllByText(WITHHELD_COPY).length).toBeGreaterThan(0);
  });

  it("keeps the registration itself visible — withholding cancel is not hiding the record", () => {
    renderIndividual(true);

    expect(screen.getByText("✓ Terdaftar")).toBeTruthy();
  });
});

describe("the team cancel affordance", () => {
  it("OFFERS the control to the captain when no bukti transfer has been submitted", () => {
    renderTeam(false);

    expect(screen.getByRole("button", { name: TEAM_CANCEL_LABEL })).toBeTruthy();
    expect(screen.queryByText(WITHHELD_COPY)).toBeNull();
  });

  it("WITHHOLDS the control once the TEAM's bukti transfer exists, and says why", () => {
    renderTeam(true);

    expect(screen.queryByRole("button", { name: TEAM_CANCEL_LABEL })).toBeNull();
    expect(screen.getAllByText(WITHHELD_COPY).length).toBeGreaterThan(0);
  });

  it("explains nothing to a non-captain, who never had the control", () => {
    // A member sees no cancel button in either state, so an explanation of its absence would be a
    // notice about a permission they never held.
    renderTeam(true, { viewerId: "user-member" });

    expect(screen.queryByRole("button", { name: TEAM_CANCEL_LABEL })).toBeNull();
    expect(screen.queryByText(WITHHELD_COPY)).toBeNull();
  });

  it("does not explain a withheld control on a team that is still forming", () => {
    // A forming team has no submitted registration and therefore no cancel control to withhold.
    renderTeam(true, { status: "forming" });

    expect(screen.queryByText(WITHHELD_COPY)).toBeNull();
  });
});
