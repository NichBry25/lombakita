import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionVerificationSummaryBySlug } from "@/server/institution-workspace/institution-service";
import { readTickPageState } from "@/server/institution-verification/tick-service";
import { absoluteSiteUrl } from "@/config/site-url";
import { InstitutionVerificationShell } from "@/components/institution/institution-verification-shell";

type InstitutionVerificationPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

// The tick page of a workspace for its owner and staff: the three ways to win the tick and the
// state of each, for every kind of workspace.
export default async function InstitutionVerificationPage({
  params,
}: InstitutionVerificationPageProps) {
  const { institutionSlug } = await params;
  const base = `/institution/${institutionSlug}/verification`;

  const session = await requireRolePage("recruiter", { callbackPath: base });

  const isMember = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isMember) {
    redirect("/recruiter-dashboard");
  }

  const summary = await loadInstitutionVerificationSummaryBySlug(institutionSlug);

  // A null summary means the slug did not resolve, but the membership guard above already confirmed
  // the institution exists, so this only fails closed against an unexpected state.
  if (!summary) {
    redirect("/recruiter-dashboard");
  }

  const tickState = await readTickPageState(session.user.id, summary.institutionId);

  // The verdict is read from the institution's own column rather than from an approved submission
  // row: a Path A tick and a staff verification both write this column and leave no submission
  // behind. Passed from the server so a verified institution never renders the Email organisasi
  // card, not even for the moment before the history loads.
  return (
    <InstitutionVerificationShell
      institutionSlug={institutionSlug}
      expectedUserId={session.user.id}
      institutionId={summary.institutionId}
      institutionType={summary.institutionType}
      displayName={summary.displayName}
      pageUrl={absoluteSiteUrl(`/institution/${summary.slug}`)}
      isVerified={summary.verificationStatus === "verified"}
      // Written by a platform-ops decision on the institution itself — a denial, or the revocation
      // of a verification that had already been granted. Without it a revoked owner would simply
      // find the form back with no explanation of what changed.
      rejectionReason={summary.verificationStatus === "rejected" ? summary.rejectionReason : null}
      tickPath={summary.tickPath}
      nameChecked={summary.nameCheckedAt !== null}
      nameProofDueAt={summary.nameProofDueAt?.toISOString() ?? null}
      tickState={tickState}
    />
  );
}
