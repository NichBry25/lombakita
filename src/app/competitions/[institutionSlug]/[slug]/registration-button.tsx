import { Button, ButtonLink, Icon } from "@/components/ui";
import type { PublicCompetitionDetail } from "@/server/competitions/competition-public-service";
import { AddToCalendarButton, type CalendarEventProps } from "./detail-actions";

export function RegistrationButton({
  ctaState,
  registrationPath,
  signInPath,
  candidateRoleOfferPath,
  isCandidate,
  isSignedIn,
  isCancelled,
  calendarEvent,
}: {
  ctaState: PublicCompetitionDetail["ctaState"];
  registrationPath: string;
  signInPath: string;
  candidateRoleOfferPath: string | null;
  isCandidate: boolean;
  isSignedIn: boolean;
  isCancelled: boolean;
  calendarEvent?: CalendarEventProps;
}) {
  if (isCancelled) {
    return (
      <Button disabled size="lg" fullWidth>
        Kompetisi dibatalkan
      </Button>
    );
  }
  if (ctaState === "open" && !isSignedIn) {
    return (
      <ButtonLink href={signInPath} variant="primary" size="lg" fullWidth>
        Daftar kompetisi
        <Icon name="arrow-right" size="md" />
      </ButtonLink>
    );
  }
  if (ctaState === "open" && isCandidate) {
    return (
      <ButtonLink href={registrationPath} variant="primary" size="lg" fullWidth>
        Daftar kompetisi
        <Icon name="arrow-right" size="md" />
      </ButtonLink>
    );
  }

  if (ctaState === "open" && !isCandidate && candidateRoleOfferPath) {
    return (
      <ButtonLink href={candidateRoleOfferPath} variant="primary" size="lg" fullWidth>
        Daftar kompetisi
        <Icon name="arrow-right" size="md" />
      </ButtonLink>
    );
  }

  if (ctaState === "open" && !isCandidate) {
    return (
      <Button disabled size="lg" fullWidth>
        Daftar kompetisi
      </Button>
    );
  }

  // "Pendaftaran belum dibuka" sits exactly on the §9 24-character cap. The visible label
  // shortens to "Belum dibuka" so it reads as a status rather than a sentence; the accessible name
  // keeps the full phrase, because someone reaching this control by screen reader has no visual
  // "Daftar kompetisi" heading above it to supply the missing subject.
  if (ctaState === "not_yet_open" && calendarEvent?.eventStartAt) {
    return <AddToCalendarButton {...calendarEvent} />;
  }

  if (ctaState === "not_yet_open") {
    return (
      <Button disabled size="lg" fullWidth aria-label="Pendaftaran belum dibuka">
        Belum dibuka
      </Button>
    );
  }

  return (
    <Button disabled size="lg" fullWidth>
      Pendaftaran ditutup
    </Button>
  );
}
