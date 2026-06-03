import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getRegistrationReview } from "@/server/participants/review-service";
import { getResultForInstitution } from "@/server/participants/result-service";
import { ReviewForm } from "./review-form";
import { ResultForm } from "./result-form";

type Props = {
  params: Promise<{ institutionSlug: string; competitionSlug: string; registrationId: string }>;
};

export default async function RegistrationReviewPage({ params }: Props) {
  const { institutionSlug, competitionSlug, registrationId } = await params;
  const session = await getCurrentSession();

  const listPath = `/institution/${institutionSlug}/competitions/${competitionSlug}/participants`;
  const selfPath = `${listPath}/${registrationId}`;

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(selfPath)}`);
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

  let competitionId: string;
  try {
    competitionId = await getCompetitionIdByInstitutionAndSlug(institutionSlug, competitionSlug, db);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError) notFound();
    throw error;
  }

  // Cross-institution competition/registration collapses to null → 404 (no info leak).
  const [review, resultCtx] = await Promise.all([
    getRegistrationReview(institutionId, competitionId, registrationId, db),
    getResultForInstitution(institutionId, competitionId, registrationId, db),
  ]);
  if (!review) {
    notFound();
  }

  const reviewApiPath = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/registrations/${registrationId}/review`;
  const resultApiBase = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/registrations/${registrationId}/result`;

  return (
    <main style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}>
      <h1>Detail peserta</h1>
      <p>
        <a href={listPath}>← Kembali ke daftar peserta</a>
      </p>
      <ReviewForm
        apiPath={reviewApiPath}
        initialStatus={review.internalReviewStatus}
        initialNotes={review.internalNotes}
        registrationType={review.registrationType}
        teamName={review.teamName}
        activeMemberCount={review.activeMemberCount}
      />
      <ResultForm
        apiBasePath={resultApiBase}
        initialStatus={resultCtx?.resultStatus ?? "draft"}
        initialLabel={resultCtx?.resultLabel ?? null}
        initialNotes={resultCtx?.resultNotes ?? null}
        registrationType={review.registrationType}
        teamName={review.teamName}
        activeMemberCount={review.activeMemberCount}
      />
    </main>
  );
}
