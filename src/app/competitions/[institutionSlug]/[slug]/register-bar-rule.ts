import type { PublicCompetitionDetail } from "@/server/competitions/competition-public-service";

// The register bar is for a button that does something: registration is open and the visitor is
// signed out (the button leads to sign-in) or a candidate (it leads to the form). In every other
// state the page's own register control already says why there is nothing to press.
export const shouldShowRegisterBar = ({
  ctaState,
  isCancelled,
  isSignedIn,
  isCandidate,
}: {
  ctaState: PublicCompetitionDetail["ctaState"];
  isCancelled: boolean;
  isSignedIn: boolean;
  isCandidate: boolean;
}): boolean => {
  if (isCancelled || ctaState !== "open") return false;
  return !isSignedIn || isCandidate;
};
