import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionVerificationSummaryBySlug } from "@/server/institution-workspace/institution-service";
import {
  isPersonalInstitutionType,
  isFullInstitutionType,
} from "@/server/institution-workspace/institution-type";
import {
  FULL_INSTITUTION_CREATION_MIN_TIER,
  getRecruiterTierForAccount,
  meetsRecruiterTier,
} from "@/server/auth/recruiter-tier";
import { InstitutionUpgradeShell } from "@/components/institution/institution-upgrade-shell";
import { InstitutionVerificationShell } from "@/components/institution/institution-verification-shell";

type InstitutionVerificationPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

// One route, two surfaces, chosen by institution type:
//   personal → "Tingkatkan level institusi" (self-service, immediate, one-way type upgrade)
//   full     → "Verifikasi institusi" (optional document review, credibility only)
// A personal institution has no document verification of its own — the person behind it is verified
// through the account-level Trusted Recruiter review — so the upgrade surface replaces it until the
// institution becomes full, at which point the verification surface takes its place.
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
  const institutionType = summary?.institutionType ?? null;

  if (isPersonalInstitutionType(institutionType)) {
    const tierState = await getRecruiterTierForAccount(session.user.id);
    const canUpgrade = Boolean(
      tierState?.recruiterVerified &&
      meetsRecruiterTier(tierState.recruiterVerificationTier, FULL_INSTITUTION_CREATION_MIN_TIER),
    );

    return (
      <InstitutionUpgradeShell
        institutionSlug={institutionSlug}
        expectedUserId={session.user.id}
        canUpgrade={canUpgrade}
      />
    );
  }

  // Every non-personal institution has a full subtype (institution_type is NOT NULL and set at
  // creation). A null here means the slug did not resolve — but the membership guard above already
  // confirmed the institution exists, so this only fails closed against an unexpected state.
  if (!isFullInstitutionType(institutionType) || !summary) {
    redirect("/recruiter-dashboard");
  }

  // The verdict is read from the institution's own column rather than from an approved submission
  // row: platform_ops can also verify an institution directly from the admin table, which writes
  // this column and leaves no submission behind. Passed from the server so a verified institution
  // never renders the submit form, not even for the moment before the history loads.
  return (
    <InstitutionVerificationShell
      institutionSlug={institutionSlug}
      expectedUserId={session.user.id}
      institutionType={institutionType}
      isVerified={summary.verificationStatus === "verified"}
      verifiedAt={summary.verifiedAt?.toISOString() ?? null}
      // Written by a platform-ops decision on the institution itself — a denial, or the revocation
      // of a verification that had already been granted. Without it a revoked owner would simply
      // find the form back with no explanation of what changed.
      rejectionReason={summary.verificationStatus === "rejected" ? summary.rejectionReason : null}
    />
  );
}
