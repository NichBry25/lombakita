import { notFound } from "next/navigation";
import { SubmissionShell } from "@/components/submissions/submission-shell";
import { CandidateDocumentRequestPanel } from "@/components/registration-documents/candidate-document-request-panel";
import { CandidatePaymentPanel } from "@/components/finance/candidate-payment-panel";
import { PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";
import { getSubmissionViewForRegistration } from "@/server/submissions/submission-service";
import { listDocumentRequestsForRegistration } from "@/server/registration-documents/registration-document-service";
import { loadCandidatePaymentView } from "@/server/finance/candidate-payment-view";

export default async function SubmissionPage({
  params,
}: {
  params: Promise<{ registrationId: string }>;
}) {
  const session = await requireRolePage("candidate", {
    callbackPath: "/candidate-dashboard",
    missingRoleRedirect: "/auth/verify-role?as=candidate",
  });

  const { registrationId } = await params;
  const view = await getSubmissionViewForRegistration(registrationId, session.user.id);

  // Null = caller cannot access this registration (missing, not owner / not a team member).
  if (!view) {
    notFound();
  }

  const documentRequests = await listDocumentRequestsForRegistration(
    session.user.id,
    registrationId,
  );

  // Null for a free competition, which is most of them. The panel is simply absent then — there is
  // no payment to describe, and an empty "Pembayaran" section would invent an obligation.
  const payment = await loadCandidatePaymentView(registrationId, session.user.id);

  return (
    <main className="page-shell app-page submission-page">
      <PageHeader
        title={`Submission ${view.competitionTitle}`}
        description="Siapkan metadata berkas, simpan versi kerja, lalu finalisasi ketika seluruh detail sudah benar."
        backHref="/candidate-dashboard"
        backLabel="Dasbor"
      />

      {/* PAYMENT LEADS. All three panels below are time-bound, but this is the only one whose
          deadline ENDS the registration when it passes — a document request gates nothing and the
          submission window closes without cancelling anyone. */}
      {payment ? (
        <CandidatePaymentPanel
          expectedUserId={session.user.id}
          competitionId={payment.competitionId}
          registrationId={registrationId}
          payment={{
            currency: payment.currency,
            grossAmount: payment.grossAmount,
            dueAt: payment.dueAt ? payment.dueAt.toISOString() : null,
            deadlineSuspended: payment.deadlineSuspended,
            status: payment.status,
            instructions: payment.instructions,
            proof: payment.proof
              ? {
                  status: payment.proof.status,
                  submittedAt: payment.proof.submittedAt.toISOString(),
                  originalFileName: payment.proof.originalFileName,
                  rejectionReason: payment.proof.rejectionReason,
                  resubmissionAllowed: payment.proof.resubmissionAllowed,
                }
              : null,
            isPayer: payment.isPayer,
            canSubmitProof: payment.canSubmitProof,
            canResubmitProof: payment.canResubmitProof,
          }}
        />
      ) : null}

      {/* Rendered above the submission form: a document request is time-bound and the submission
          window usually is not, so the thing with a deadline goes first. It gates nothing. */}
      <CandidateDocumentRequestPanel
        expectedUserId={session.user.id}
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
          files: request.files.map((file) => ({
            id: file.id,
            originalFileName: file.originalFileName,
            fileSizeBytes: file.fileSizeBytes,
            createdAt: file.createdAt.toISOString(),
          })),
        }))}
      />

      <SubmissionShell
        expectedUserId={session.user.id}
        competitionId={view.competitionId}
        registrationId={registrationId}
        windowOpen={view.windowOpen}
        registrationCancelled={view.registrationStatus === "cancelled"}
        initialSubmission={
          view.submission
            ? {
                fileName: view.submission.fileName,
                fileKey: view.submission.fileKey,
                version: view.submission.version,
                finalizedAt: view.submission.finalizedAt
                  ? view.submission.finalizedAt.toISOString()
                  : null,
              }
            : null
        }
      />
    </main>
  );
}
