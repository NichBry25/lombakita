import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-20">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Lombakita Platform Baseline</h1>
        <p className="max-w-2xl text-zinc-600">
          Step 1.5 deployment baseline is active. Managed-environment contracts, staging runtime
          rules, and migration safeguards are in place while business features remain intentionally
          deferred.
        </p>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Step 1.5 Status</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
          <li>Auth.js, identity persistence, and role-access skeleton</li>
          <li>User-domain and institution membership foundation</li>
          <li>Managed PostgreSQL-ready env contract and SSL controls</li>
          <li>Staging deployment runbook and guarded migration flow</li>
          <li>No student/institution/competition business workflows yet</li>
        </ul>
      </section>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Auth and Ops Endpoints</h2>
        <ul className="space-y-1 text-sm text-zinc-700">
          <li>
            Sign-in page:{" "}
            <Link className="underline" href="/auth/sign-in">
              /auth/sign-in
            </Link>
          </li>
          <li>
            Protected example page:{" "}
            <Link className="underline" href="/protected">
              /protected
            </Link>
          </li>
          <li>
            Session API example:{" "}
            <Link className="underline" href="/api/v1/auth/session">
              /api/v1/auth/session
            </Link>
          </li>
          <li>
            Tenant context API example:{" "}
            <Link className="underline" href="/api/v1/auth/context">
              /api/v1/auth/context
            </Link>
          </li>
          <li>
            Health endpoint:{" "}
            <Link className="underline" href="/api/health">
              /api/health
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
