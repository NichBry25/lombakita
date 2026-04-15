import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { assertAuthenticatedSession, buildAccessContext } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { redirect } from "next/navigation";

export default async function ProtectedPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=%2Fprotected");
  }

  const authenticatedSession = assertAuthenticatedSession(session);
  const access = buildAccessContext(authenticatedSession);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Protected Baseline Page</h1>
        <p className="text-sm text-zinc-700">
          This route verifies authenticated session access through shared server-side guards.
        </p>
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

      <div className="flex items-center gap-4">
        <SignOutButton />

        <Link className="text-sm underline" href="/">
          Back to home
        </Link>
      </div>
    </main>
  );
}
