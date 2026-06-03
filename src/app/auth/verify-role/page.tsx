import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import {
  dashboardPathForRole,
  getUnverifiedRoles,
  isVerifiableRole,
  type VerifiableRole,
} from "@/server/auth/role-verification";
import { StubCompleteButton } from "./stub-complete-button";

const ROLE_HEADLINE: Record<VerifiableRole, string> = {
  candidate: "Verifikasi sebagai kandidat",
  recruiter: "Verifikasi sebagai rekruter",
};

// STUB: CCR-19 — verification mechanics deferred. This page replaces what will eventually be
// the real candidate/recruiter verification flow. For now it shows a single completion button
// that flips the per-role *_verified_at timestamp via the stub completion API.
export default async function VerifyRolePage(props: {
  searchParams?: Promise<{ as?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/");
  }

  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;

  if (!isVerifiableRole(asParam)) {
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: "3rem 1rem" }}>
        <h1>Verifikasi peran</h1>
        <p style={{ color: "#b91c1c" }}>
          Parameter <code>?as=</code> tidak valid. Gunakan{" "}
          <code>?as=candidate</code> atau <code>?as=recruiter</code>.
        </p>
        <p style={{ marginTop: "1rem" }}>
          <Link href="/">Kembali</Link>
        </p>
      </main>
    );
  }

  const role = asParam;
  const unverified = await getUnverifiedRoles(session.user.id);

  // If the role is already verified for this account, send the user on. Avoids a confusing
  // "complete verification" button that would 409 immediately on submit.
  if (!unverified.includes(role)) {
    redirect(dashboardPathForRole(role));
  }

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "3rem 1rem" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>{ROLE_HEADLINE[role]}</h1>

      <p
        style={{
          background: "#fef9c3",
          border: "1px solid #facc15",
          padding: "0.75rem 1rem",
          borderRadius: 6,
          color: "#854d0e",
          fontSize: "0.85rem",
        }}
      >
        Ini adalah halaman <strong>stub pengembangan</strong>. Alur verifikasi sesungguhnya
        (formulir, unggah dokumen, tinjauan ops) belum diimplementasikan dan dijadwalkan pada
        fase berikutnya (CCR-19).
      </p>

      <p style={{ color: "#555", margin: "1rem 0" }}>
        Klik tombol di bawah untuk mensimulasikan penyelesaian verifikasi. Setelah berhasil,
        sesi Anda akan disegarkan dan Anda akan diarahkan ke dasbor peran terkait.
      </p>

      <StubCompleteButton role={role} />

      <p style={{ marginTop: "1.5rem", fontSize: "0.85rem" }}>
        <Link href="/">Batal — kembali</Link>
      </p>
    </main>
  );
}
