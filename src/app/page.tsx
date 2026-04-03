import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-20">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Lombakita Platform Baseline</h1>
        <p className="max-w-2xl text-zinc-600">
          Step 1.1 scaffold is active. Business features, auth flows, and domain-specific
          implementation are intentionally deferred.
        </p>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Scaffold Status</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
          <li>Repository structure and guardrails initialized</li>
          <li>Env, provider, and server scaffolding in place</li>
          <li>Lint, typecheck, test, and CI baseline configured</li>
          <li>No business domain features implemented yet</li>
        </ul>
      </section>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Operational Endpoints</h2>
        <p className="text-sm text-zinc-700">
          Health endpoint:{" "}
          <Link className="underline" href="/api/health">
            /api/health
          </Link>
        </p>
      </section>
    </main>
  );
}
