import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Icon } from "@/components/ui";

export default async function ActivatedPage(props: { searchParams?: Promise<{ email?: string }> }) {
  const searchParams = await props.searchParams;
  const email = searchParams?.email;
  const signInHref = email
    ? `/auth/login?verified=1&email=${encodeURIComponent(email)}`
    : "/auth/login?verified=1";

  return (
    <AuthPageFrame
      eyebrow="Verifikasi email"
      title="Akses dimulai dari identitas yang terkonfirmasi."
      description="Email yang terverifikasi menjaga akun dan setiap tindakan berikutnya tetap terhubung dengan pemilik yang tepat."
    >
      <div className="auth-state stack-md">
        <span className="auth-state-icon" aria-hidden="true">
          <Icon name="check" size="lg" />
        </span>
        <div className="stack-xs">
          <p className="eyebrow">Email terverifikasi</p>
          <h1>Akun Anda sudah aktif</h1>
          <p>Verifikasi berhasil. Lanjutkan login menggunakan email dan password Anda.</p>
        </div>
        <ButtonLink href={signInHref} variant="primary">
          Lanjut ke login
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
