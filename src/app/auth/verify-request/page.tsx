import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Icon } from "@/components/ui";

export default function VerifyRequestPage() {
  return (
    <AuthPageFrame
      title="Satu langkah lagi sebelum akun aktif."
      description="Tautan verifikasi dikirim ke alamat yang digunakan saat pendaftaran."
    >
      <div className="auth-state stack-md">
        <span className="auth-state-icon" aria-hidden="true">
          <Icon name="inbox" size="lg" />
        </span>
        <div className="stack-xs">
          <h1>Periksa email Anda</h1>
          <p>
            Jika Anda baru mendaftar, kami telah mengirim email verifikasi akun. Periksa juga folder
            spam bila pesan belum terlihat.
          </p>
        </div>
        <ButtonLink href="/auth/login" variant="outline">
          Kembali ke halaman masuk
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
