import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { getDb } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getRegistrationReview } from "@/server/participants/review-service";
import { getResultForInstitution } from "@/server/participants/result-service";
import { listDocumentRequestsForCompetition } from "@/server/registration-documents/registration-document-service";
import { OrganiserDocumentRequestPanel } from "@/components/registration-documents/organiser-document-request-panel";
import { ReviewForm } from "./review-form";
import { ResultForm } from "./result-form";
import { PageHeader } from "@/components/ui";

type Props = {
  params: Promise<{ institutionSlug: string; competitionSlug: string; registrationId: string }>;
};

export default async function RegistrationReviewPage({ params }: Props) {
  const { institutionSlug, competitionSlug, registrationId } = await params;

  const listPath = `/institution/${institutionSlug}/competitions/${competitionSlug}/participants`;
  const selfPath = `${listPath}/${registrationId}`;

  const session = await requireRolePage("recruiter", { callbackPath: selfPath });

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
    competitionId = await getCompetitionIdByInstitutionAndSlug(
      institutionSlug,
      competitionSlug,
      db,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError) notFound();
    throw error;
  }

  // Cross-institution competition/registration collapses to null → 404 (no info leak).
  const [review, resultCtx, documentRequests] = await Promise.all([
    getRegistrationReview(institutionId, competitionId, registrationId, db),
    getResultForInstitution(institutionId, competitionId, registrationId, db),
    listDocumentRequestsForCompetition(institutionId, competitionId, { registrationId }, db),
  ]);
  if (!review) {
    notFound();
  }

  const reviewApiPath = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/registrations/${registrationId}/review`;
  const resultApiBase = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/registrations/${registrationId}/result`;

  return (
    <main className="page-shell app-page participant-review-page">
      <PageHeader
        title="Detail peserta"
        description="Catatan internal tidak terlihat oleh peserta."
        backHref={listPath}
        backLabel="Peserta"
      />
      <ReviewForm
        apiPath={reviewApiPath}
        initialStatus={review.internalReviewStatus}
        initialNotes={review.internalNotes}
        registrationType={review.registrationType}
        teamName={review.teamName}
        activeMemberCount={review.activeMemberCount}
      />
      <OrganiserDocumentRequestPanel
        institutionSlug={institutionSlug}
        competitionId={competitionId}
        registrationId={registrationId}
        requests={documentRequests.map((request) => ({
          id: request.id,
          title: request.title,
          instructions: request.instructions,
          dueAt: request.dueAt.toISOString(),
          status: request.status,
          displayStatus: request.display.status,
          isOverdue: request.display.isOverdue,
          isLate: request.display.isLate,
          reviewNote: request.reviewNote,
          revisionCount: request.revisionCount,
          files: request.files.map((file) => ({
            id: file.id,
            originalFileName: file.originalFileName,
            fileSizeBytes: file.fileSizeBytes,
            createdAt: file.createdAt.toISOString(),
          })),
        }))}
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
