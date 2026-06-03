import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SubmissionShell } from "@/components/submissions/submission-shell";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import { getSubmissionViewForRegistration } from "@/server/submissions/submission-service";

export default async function SubmissionPage({
  params,
}: {
  params: Promise<{ registrationId: string }>;
}) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/candidate-dashboard");
  }

  // DEC-0060 — candidate capability is derived per-request from verification state.
  const unverified = await getUnverifiedRoles(session.user.id);
  if (unverified.includes("candidate")) {
    redirect("/auth/verify-role?as=candidate");
  }

  const { registrationId } = await params;
  const view = await getSubmissionViewForRegistration(registrationId, session.user.id);

  // Null = caller cannot access this registration (missing, not owner / not a team member).
  if (!view) {
    notFound();
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" }}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/candidate-dashboard" style={{ color: "#355795", fontSize: "0.9em" }}>
          ← Dasbor Kandidat
        </Link>
      </p>
      <h1 style={{ marginBottom: "1rem" }}>Submission — {view.competitionTitle}</h1>

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
