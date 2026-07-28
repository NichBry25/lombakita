import { notFound } from "next/navigation";
import { SubmissionShell } from "@/components/submissions/submission-shell";
import { PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";
import { getSubmissionViewForRegistration } from "@/server/submissions/submission-service";

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

  return (
    <main className="page-shell app-page submission-page">
      <PageHeader
        title={`Submission — ${view.competitionTitle}`}
        description="Siapkan metadata berkas, simpan versi kerja, lalu finalisasi ketika seluruh detail sudah benar."
        backHref="/candidate-dashboard"
        backLabel="Dasbor"
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
