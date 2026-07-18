import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Feedback } from "@/components/ui";
import { getCurrentSession } from "@/server/auth/session";

// STUB: CCR-19 — recruiter elevated-tier verification deferred to Step 4.0c. This page is a
// static placeholder reachable from the recruiter dashboard. No API call, no DB write, no
// state transition fires here.
export default async function VerifyTierPage(props: {
  searchParams?: Promise<{ target?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/auth/verify-tier?target=elevated");
  }

  const searchParams = await props.searchParams;
  const target = searchParams?.target ?? "elevated";

  return (
    <AuthPageFrame
      eyebrow="Verifikasi rekruter"
      title="Akses tingkat lanjut memerlukan pemeriksaan tambahan."
      description="Peningkatan akses dibuka bertahap agar tindakan institusi tetap sesuai dengan tingkat kepercayaan akun."
    >
      <div className="auth-state stack-md">
        <div className="stack-xs">
          <p className="eyebrow">Status pengembangan</p>
          <h1>Verifikasi rekruter tingkat lanjut</h1>
        </div>
        <Feedback tone="warning">
          Tingkat verifikasi <code>{target}</code> akan diimplementasikan pada Step 4.0c. Halaman
          ini hanya placeholder.
        </Feedback>
        <ButtonLink href="/recruiter-dashboard" variant="primary">
          Kembali ke dasbor rekruter
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
