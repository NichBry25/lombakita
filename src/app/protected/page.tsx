import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { ButtonLink, PageHeader } from "@/components/ui";
import { assertAuthenticatedSession, buildAccessContext } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

// Development diagnostic. Renders the current session, the user's user-level role, and the
// per-role verification flags (candidateVerifiedAt / recruiterVerifiedAt) so the candidate-only vs
// recruiter-only state is visibly distinguishable in the browser.
//
// It does not exist in production, for any role: the page prints a signed-in user's id, email and
// verification timestamps as raw JSON, which is diagnostic output rather than a product surface.
// The check runs before the session is read so no query is made for a page that will not render.
export default async function ProtectedPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=%2Fprotected");
  }

  const authenticatedSession = assertAuthenticatedSession(session);
  const access = buildAccessContext(authenticatedSession);

  const db = getDb();
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      candidateVerifiedAt: users.candidateVerifiedAt,
      recruiterVerifiedAt: users.recruiterVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, authenticatedSession.user.id))
    .limit(1);

  return (
    <main className="page-shell app-page protected-page">
      <PageHeader
        title="Sesi aktif"
        description="Halaman internal untuk memeriksa sesi dan verifikasi per peran."
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Konteks autentikasi</p>
            <h2>Session</h2>
          </div>
        </div>
        <pre className="diagnostic-code">
          {JSON.stringify(
            {
              user: {
                id: authenticatedSession.user.id,
                email: authenticatedSession.user.email,
                role: authenticatedSession.user.role,
              },
              access,
            },
            null,
            2,
          )}
        </pre>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Status akun</p>
            <h2>Verifikasi per peran</h2>
          </div>
        </div>
        <pre className="diagnostic-code">
          {JSON.stringify(
            {
              role: row?.role,
              candidateVerified: row?.candidateVerifiedAt !== null,
              recruiterVerified: row?.recruiterVerifiedAt !== null,
              candidateVerifiedAt: row?.candidateVerifiedAt,
              recruiterVerifiedAt: row?.recruiterVerifiedAt,
            },
            null,
            2,
          )}
        </pre>
        <p className="form-help">
          Probe candidate-only gate: <code>GET /api/v1/me/candidate-only</code> · Probe
          recruiter-only gate: <code>GET /api/v1/me/recruiter-only</code>
        </p>
      </section>

      <div className="page-secondary-actions">
        <SignOutButton />
        <ButtonLink href="/" variant="ghost" size="sm">
          Kembali ke beranda
        </ButtonLink>
      </div>
    </main>
  );
}
