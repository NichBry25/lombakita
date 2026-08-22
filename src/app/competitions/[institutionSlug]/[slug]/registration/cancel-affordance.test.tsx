// @vitest-environment jsdom
//
// DEC-0131's cancel affordance is WITHHELD, and this is the only place that can prove it.
//
// `ui-states` reads rendered text and the browser audits measure geometry, so neither can tell a
// withheld control from a disabled one. A disabled "Batalkan pendaftaran" still renders those
// words. The distinction is the whole ruling: a control that appears and then refuses teaches a
// candidate the platform is broken, a control that is absent next to a sentence teaches them the
// rule. So each case is asserted in BOTH directions: the control is present when the predicate is
// false, and ABSENT, not merely disabled, when it is true.
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
        registrationWithheld={false}
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
        registrationWithheld={false}
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

  it("keeps the registration itself visible: withholding cancel is not hiding the record", () => {
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

// DEC-0170'S REFUSAL, ON BOTH ENTRY PATHS.
//
// The individual path withheld its one control and the team path withheld only its LAST one, so a
// candidate could still form a team, become its captain and invite people into a competition whose
// organiser cannot accept a registration. That is the sibling asymmetry M1 was, moved from a write
// path to an entry path: two ways in, one enforcing less than the other.
//
// Asserted in both directions on both paths, because a test that only checks the withheld state
// passes against a section that renders nothing at all.

const renderTeamEntry = (registrationWithheld: boolean) =>
  render(
    <UIPrimitivesProvider>
      <CompetitionTeamSection
        competitionId="comp-1"
        competitionMode="both"
        minTeamSize={2}
        maxTeamSize={4}
        registrationOpen={!registrationWithheld}
        expectedUserId={CAPTAIN}
        initialTeam={null}
        initialMembers={[]}
        initialPendingInvitations={[]}
        registrationWithheld={registrationWithheld}
        cancellationClosedByPaymentProof={false}
      />
    </UIPrimitivesProvider>,
  );

const renderIndividualEntry = (registrationWithheld: boolean) =>
  render(
    <UIPrimitivesProvider>
      <IndividualRegistrationSection
        competitionId="comp-1"
        ctaState="open"
        initialRegistration={null}
        expectedUserId="user-1"
        modeLabel="Daftar"
        registrationWithheld={registrationWithheld}
        cancellationClosedByPaymentProof={false}
      />
    </UIPrimitivesProvider>,
  );

describe("the way in, when the organiser cannot take payment", () => {
  it("OFFERS team creation while the organiser can still be paid", () => {
    renderTeamEntry(false);

    expect(screen.getByRole("button", { name: "Buat tim" })).toBeTruthy();
  });

  it("WITHHOLDS team creation entirely, not just the register action", () => {
    renderTeamEntry(true);

    expect(screen.queryByRole("button", { name: "Buat tim" })).toBeNull();
    expect(screen.queryByPlaceholderText("Nama tim")).toBeNull();
  });

  it("stops pointing at an individual Daftar button that is itself withheld", () => {
    // The copy named a control the sibling path correctly does not render in this state.
    renderTeamEntry(true);

    expect(screen.queryByText(/di tombol Daftar di atas/)).toBeNull();
  });

  it("still points at it when that button is really there", () => {
    renderTeamEntry(false);

    expect(screen.getByText(/di tombol Daftar di atas/)).toBeTruthy();
  });

  it("OFFERS individual registration while the organiser can still be paid", () => {
    renderIndividualEntry(false);

    expect(screen.getByRole("button", { name: "Daftar" })).toBeTruthy();
  });

  it("WITHHOLDS individual registration, the sibling that was already correct", () => {
    renderIndividualEntry(true);

    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });
});

// WHAT THE CARD SAYS ONCE ITS CONTROL IS GONE.
//
// The block above asserts only that the controls disappear, and a card that renders its heading and
// then nothing at all satisfies every one of those nulls. That is what both cards did: the refusal
// was stated once in a page banner, and the two cards under it were empty shells. Each direction is
// asserted on each path, so a sentence that renders unconditionally fails here too.
describe("what the withheld cards say instead", () => {
  it("explains the missing individual control in the card that lost it", () => {
    renderIndividualEntry(true);

    expect(screen.getByText(/Pendaftaran individu belum dapat dibuka/)).toBeTruthy();
  });

  it("says nothing of the sort while the control is really there", () => {
    renderIndividualEntry(false);

    expect(screen.queryByText(/Pendaftaran individu belum dapat dibuka/)).toBeNull();
  });

  it("explains the missing team form in the card that lost it", () => {
    renderTeamEntry(true);

    expect(screen.getByText(/Pembuatan tim belum dapat dibuka/)).toBeTruthy();
  });

  it("says nothing of the sort while the form is really there", () => {
    renderTeamEntry(false);

    expect(screen.queryByText(/Pembuatan tim belum dapat dibuka/)).toBeNull();
  });
});

// WHERE THE WITHHELD SENTENCE SITS, which is as load-bearing as whether it renders.
//
// The neutral tone paints the inset ground. `.registration-state` paints the same ground, so a
// neutral note placed inside that panel is background on background and the candidate reads an
// empty card, which is the state this whole pass exists to remove. Asserted structurally rather
// than by colour, because jsdom applies no stylesheet and a colour assertion here would pass
// against anything.
describe("where the withheld cancel note is placed", () => {
  it("keeps the note out of the inset panel it would vanish into", () => {
    const { container } = renderIndividual(true);
    const note = screen.getByText(WITHHELD_COPY).closest(".feedback");

    expect(note).toBeTruthy();
    expect(container.querySelector(".registration-state")).toBeTruthy();
    expect(note?.closest(".registration-state")).toBeNull();
  });

  it("still keeps the cancel control inside that panel when it is offered", () => {
    // The pair. Without it the test above passes against a component that stopped rendering the
    // panel at all, which would be a different regression wearing the same green.
    const { container } = renderIndividual(false);
    const button = screen.getByRole("button", { name: CANCEL_LABEL });

    expect(button.closest(".registration-state")).toBe(
      container.querySelector(".registration-state"),
    );
  });
});
