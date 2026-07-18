import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Feedback } from "@/components/ui";
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
export default async function VerifyRolePage(props: { searchParams?: Promise<{ as?: string }> }) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/");
  }

  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;

  if (!isVerifiableRole(asParam)) {
    return (
      <AuthPageFrame
        eyebrow="Verifikasi peran"
        title="Peran menentukan jalur verifikasi yang tepat."
        description="Kandidat dan rekruter memiliki kebutuhan akses yang berbeda dan diverifikasi secara terpisah."
      >
        <div className="auth-state stack-md">
          <span className="auth-state-icon" data-tone="error" aria-hidden="true">
            !
          </span>
          <div className="stack-xs">
            <h1>Verifikasi peran</h1>
            <Feedback tone="error">
              Parameter <code>?as=</code> tidak valid. Gunakan <code>?as=candidate</code> atau{" "}
              <code>?as=recruiter</code>.
            </Feedback>
          </div>
          <ButtonLink href="/" variant="outline">
            Kembali
          </ButtonLink>
        </div>
      </AuthPageFrame>
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
    <AuthPageFrame
      eyebrow="Verifikasi peran"
      title="Bangun kepercayaan sebelum membuka akses."
      description="Setiap peran melewati jalur verifikasi tersendiri agar tindakan kandidat dan penyelenggara tetap dapat dipertanggungjawabkan."
    >
      <div className="auth-state stack-md">
        <div className="stack-xs">
          <p className="eyebrow">Status pengembangan</p>
          <h1>{ROLE_HEADLINE[role]}</h1>
        </div>

        <Feedback tone="warning">
          Ini adalah halaman <strong>stub pengembangan</strong>. Alur verifikasi sesungguhnya
          (formulir, unggah dokumen, tinjauan ops) belum diimplementasikan dan dijadwalkan pada fase
          berikutnya (CCR-19).
        </Feedback>

        <p>
          Klik tombol di bawah untuk mensimulasikan penyelesaian verifikasi. Setelah berhasil, sesi
          Anda akan disegarkan dan Anda akan diarahkan ke dasbor peran terkait.
        </p>

        <StubCompleteButton role={role} />
        <ButtonLink href="/" variant="ghost" size="sm">
          Batal — kembali
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
