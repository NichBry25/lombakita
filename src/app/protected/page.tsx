import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { assertAuthenticatedSession, buildAccessContext } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

// Rollback Step 1.3 minimal-proof surface.
// Renders the current session, the user's user-level role, and the per-role verification flags
// (candidateVerifiedAt / recruiterVerifiedAt) so the candidate-only vs recruiter-only state is
// visibly distinguishable in the browser. Pre-existing /protected behaviour preserved.
export default async function ProtectedPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=%2Fprotected");
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
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Sesi Aktif</h1>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-5">
        <h2 className="mb-2 text-sm font-semibold">Session</h2>
        <pre className="overflow-auto rounded bg-zinc-100 p-3 text-xs text-zinc-800">
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

      <section className="rounded border border-zinc-200 bg-white p-5">
        <h2 className="mb-2 text-sm font-semibold">Per-role verification (CCR-02 / DEC-0036)</h2>
        <pre className="overflow-auto rounded bg-zinc-100 p-3 text-xs text-zinc-800">
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
        <p className="mt-2 text-xs text-zinc-600">
          Probe candidate-only gate:{" "}
          <code className="rounded bg-zinc-200 px-1">GET /api/v1/me/candidate-only</code> · Probe
          recruiter-only gate:{" "}
          <code className="rounded bg-zinc-200 px-1">GET /api/v1/me/recruiter-only</code>
        </p>
      </section>

      <div className="flex items-center gap-4">
        <SignOutButton />

        <Link className="text-sm underline" href="/">
          Back to home
        </Link>
      </div>
    </main>
  );
}
