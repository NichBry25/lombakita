import Link from "next/link";

// Step 6.5c — public, static suspension destination. Reachable while unauthenticated (no auth
// guard, no middleware) and carries no query parameter identifying the user. It deliberately
// renders NO user-specific data and NEVER the internal moderation `suspension_reason` — it states
// the account is suspended, shows Lombakita support contact, and gives plain-language appeal
// instructions. Minimal proof only: no styling beyond what is needed to read it.
const SUPPORT_EMAIL = "dukungan@lombakita.id";

export default function SuspendedPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-20">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Akun Anda ditangguhkan</h1>
        <p className="text-zinc-600">
          Akun ini sedang ditangguhkan oleh tim Lombakita, sehingga Anda tidak dapat masuk untuk
          saat ini. Penangguhan dilakukan setelah peninjauan internal.
        </p>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-2 text-lg font-medium">Hubungi dukungan</h2>
        <p className="text-sm text-zinc-700">
          Jika Anda merasa penangguhan ini keliru atau ingin mengajukan banding, hubungi tim
          dukungan Lombakita melalui email berikut:
        </p>
        <p className="mt-2 text-sm font-medium text-zinc-900">
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
        </p>
      </section>

      <section className="rounded border border-zinc-200 bg-white p-6">
        <h2 className="mb-2 text-lg font-medium">Cara mengajukan banding</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-700">
          <li>Kirim email ke alamat dukungan di atas dari alamat email akun Anda.</li>
          <li>Tuliskan nama akun dan jelaskan secara singkat keberatan Anda.</li>
          <li>Tim Lombakita akan meninjau permintaan banding Anda dan membalas melalui email.</li>
        </ol>
      </section>

      <p className="text-sm text-zinc-600">
        <Link className="underline" href="/">
          Kembali ke beranda
        </Link>
      </p>
    </main>
  );
}
