import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";

// STUB: CCR-19 — recruiter elevated-tier verification deferred to Step 4.0c. This page is a
// static placeholder reachable from the recruiter dashboard. No API call, no DB write, no
// state transition fires here.
export default async function VerifyTierPage(props: {
  searchParams?: Promise<{ target?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=/auth/verify-tier?target=elevated");
  }

  const searchParams = await props.searchParams;
  const target = searchParams?.target ?? "elevated";

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "3rem 1rem" }}>
      <h1>Verifikasi rekruter tingkat lanjut (stub)</h1>

      <p
        style={{
          background: "#fef9c3",
          border: "1px solid #facc15",
          padding: "0.75rem 1rem",
          borderRadius: 6,
          color: "#854d0e",
          fontSize: "0.85rem",
          marginBottom: "1.25rem",
        }}
      >
        Tingkat verifikasi <code>{target}</code> akan diimplementasikan pada Step 4.0c.
        Halaman ini hanya placeholder.
      </p>

      <Link
        href="/recruiter-dashboard"
        style={{
          padding: "0.5rem 1rem",
          background: "#355795",
          color: "#fff",
          borderRadius: 6,
          textDecoration: "none",
          fontSize: "0.9rem",
        }}
      >
        Kembali ke dasbor rekruter
      </Link>
    </main>
  );
}
