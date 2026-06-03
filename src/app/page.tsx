import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-20">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Lombakita</h1>
        <p className="max-w-2xl text-zinc-600">
          Platform peluang mahasiswa Indonesia. Temukan kompetisi, beasiswa, dan magang dari
          institusi terpercaya.
        </p>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium">Mulai</h2>
        <ul className="space-y-1 text-sm text-zinc-700">
          <li>
            <Link className="underline" href="/auth/login">
              Login atau daftar akun
            </Link>
          </li>
          <li>
            <Link className="underline" href="/institution/workspace" prefetch={false}>
              Buat workspace institusi
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
