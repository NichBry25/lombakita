import { notFound, redirect } from "next/navigation";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getRegistrationReview } from "@/server/participants/review-service";
import { ReviewForm } from "./review-form";

type Props = {
  params: Promise<{ institutionSlug: string; competitionId: string; registrationId: string }>;
};

export default async function RegistrationReviewPage({ params }: Props) {
  const { institutionSlug, competitionId, registrationId } = await params;
  const session = await getCurrentSession();

  const listPath = `/institution/${institutionSlug}/competitions/${competitionId}/participants`;
  const selfPath = `${listPath}/${registrationId}`;

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(selfPath)}`);
  }
  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  const db = getDb();
  let institutionId: string;
  try {
    ({ institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug.trim().toLowerCase(),
      db,
    ));
  } catch (e) {
    if (e instanceof AccessError) redirect("/");
    throw e;
  }

  // Cross-institution competition/registration collapses to null → 404 (no info leak).
  const review = await getRegistrationReview(institutionId, competitionId, registrationId, db);
  if (!review) {
    notFound();
  }

  const apiPath = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/registrations/${registrationId}/review`;

  return (
    <main style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}>
      <h1>Tinjauan peserta</h1>
      <p>
        <a href={listPath}>← Kembali ke daftar peserta</a>
      </p>
      <ReviewForm
        apiPath={apiPath}
        initialStatus={review.internalReviewStatus}
        initialNotes={review.internalNotes}
        registrationType={review.registrationType}
        teamName={review.teamName}
        activeMemberCount={review.activeMemberCount}
      />
    </main>
  );
}
