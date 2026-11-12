import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Icon } from "@/components/ui";

export default function VerifyEmailPage() {
  return (
    <AuthPageFrame
      title="Verifikasi email kini memakai kode."
      description="Kode 6 digit dikirim ke email Anda saat Anda mendaftar atau masuk."
    >
      <div className="auth-state stack-md">
        <span className="auth-state-icon" aria-hidden="true">
          <Icon name="info" size="lg" />
        </span>
        <div className="stack-xs">
          <h1>Tautan ini sudah tidak dipakai</h1>
          <p>
            Lombakita sekarang memverifikasi email dengan kode. Masuk dengan email dan password
            Anda, lalu minta kode verifikasi.
          </p>
        </div>
        <ButtonLink href="/auth/login" variant="primary">
          Ke halaman masuk
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
