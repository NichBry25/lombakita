import Link from "next/link";

export default async function ActivatedPage(props: { searchParams?: Promise<{ email?: string }> }) {
  const searchParams = await props.searchParams;
  const email = searchParams?.email;
  const signInHref = email
    ? `/auth/login?verified=1&email=${encodeURIComponent(email)}`
    : "/auth/login?verified=1";

  return (
    <main className="mx-auto flex min-h-[76vh] w-full max-w-3xl flex-1 items-center justify-center px-6 py-12">
      <section className="glass-card w-full max-w-2xl p-8 text-center md:p-10">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          Email Verification
        </p>
        <h1 className="text-gleam mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)] md:text-5xl">
          Akun Anda Sudah Aktif
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-[var(--text-muted)]">
          Verifikasi berhasil. Lanjutkan login menggunakan email dan password Anda.
        </p>

        <div className="mt-8">
          <Link href={signInHref} className="primary-button inline-flex">
            Lanjut ke Login
          </Link>
        </div>
      </section>
    </main>
  );
}
