import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionTypeBySlug } from "@/server/institution-workspace/institution-service";
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

  const institutionType = await loadInstitutionTypeBySlug(institutionSlug);

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
  if (!isFullInstitutionType(institutionType)) {
    redirect("/recruiter-dashboard");
  }

  return (
    <InstitutionVerificationShell
      institutionSlug={institutionSlug}
      expectedUserId={session.user.id}
      institutionType={institutionType}
    />
  );
}
