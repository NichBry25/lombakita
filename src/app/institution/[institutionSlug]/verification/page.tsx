import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionVerificationSummaryBySlug } from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import { InstitutionVerificationShell } from "@/components/institution/institution-verification-shell";

type InstitutionVerificationPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

// Document verification for a workspace's owner and staff. A personal workspace has none yet, so the
// page sends its owner to the workspace hub.
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

  // A personal workspace cannot submit verification documents (the verification service refuses its
  // kind), so its owner is sent to the workspace hub.
  if (isPersonalInstitutionType(summary.institutionType)) {
    redirect(`/institution/${institutionSlug}`);
  }

  // The verdict is read from the institution's own column rather than from an approved submission
  // row: platform_ops can also verify an institution directly from the admin table, which writes
  // this column and leaves no submission behind. Passed from the server so a verified institution
  // never renders the submit form, not even for the moment before the history loads.
  return (
    <InstitutionVerificationShell
      institutionSlug={institutionSlug}
      expectedUserId={session.user.id}
      institutionType={summary.institutionType}
      isVerified={summary.verificationStatus === "verified"}
      verifiedAt={summary.verifiedAt?.toISOString() ?? null}
      // Written by a platform-ops decision on the institution itself — a denial, or the revocation
      // of a verification that had already been granted. Without it a revoked owner would simply
      // find the form back with no explanation of what changed.
      rejectionReason={summary.verificationStatus === "rejected" ? summary.rejectionReason : null}
    />
  );
}
