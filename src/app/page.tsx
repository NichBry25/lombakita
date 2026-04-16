import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-20">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Lombakita Platform Baseline</h1>
        <p className="max-w-2xl text-zinc-600">
          Step 2.2 institution workspace creation baseline is active. Authenticated users can create
          an institution tenant with durable owner membership and manage a minimal settings shell.
        </p>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Step 2.2 Status</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
          <li>Auth.js credentials login with Resend-verified registration</li>
          <li>User-domain and institution membership foundation</li>
          <li>Student profile shell endpoint and guarded profile page</li>
          <li>Institution tenant creation endpoint with owner membership assignment</li>
          <li>Slug-based institution settings shell with owner-only updates</li>
          <li>Managed PostgreSQL-ready env contract and guarded migration flow</li>
          <li>No staff invitations, verification workflow, competition tooling, or payments</li>
        </ul>
      </section>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Current Runtime Surfaces</h2>
        <ul className="space-y-1 text-sm text-zinc-700">
          <li>
            Student profile page:{" "}
            <Link className="underline" href="/student/profile" prefetch={false}>
              /student/profile
            </Link>
          </li>
          <li>
            Student profile API:{" "}
            <Link className="underline" href="/api/v1/students/me/profile" prefetch={false}>
              /api/v1/students/me/profile
            </Link>
          </li>
          <li>
            Institution workspace page:{" "}
            <Link className="underline" href="/institution/workspace" prefetch={false}>
              /institution/workspace
            </Link>
          </li>
          <li>
            Institution create API:{" "}
            <Link className="underline" href="/api/v1/institutions" prefetch={false}>
              /api/v1/institutions
            </Link>
          </li>
          <li>
            Sign-in page:{" "}
            <Link className="underline" href="/auth/sign-in">
              /auth/sign-in
            </Link>
          </li>
          <li>
            Protected example page:{" "}
            <Link className="underline" href="/protected" prefetch={false}>
              /protected
            </Link>
          </li>
          <li>
            Session API example:{" "}
            <Link className="underline" href="/api/v1/auth/session" prefetch={false}>
              /api/v1/auth/session
            </Link>
          </li>
          <li>
            Tenant context API example:{" "}
            <Link className="underline" href="/api/v1/auth/context" prefetch={false}>
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
