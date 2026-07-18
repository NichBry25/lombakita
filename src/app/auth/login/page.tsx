import Link from "next/link";
import { AuthEntry } from "@/components/auth/auth-entry";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { OAuthRolePicker } from "@/components/auth/oauth-role-picker";
import { isEmailAuthConfigured, isGoogleAuthConfigured } from "@/server/auth/auth.config";
import { verifyGoogleIdentityCarrier } from "@/server/auth/oauth-identity-carrier";
import { resolveClaimInviteEmailByToken } from "@/server/invitations/invite-resolution";
import { getDb } from "@/server/db/client";

// Step 6.5d.1 — single method-first auth entry. `/auth/login` is the one canonical entry point;
// `/auth/register`, `/auth/signup`, and `/auth/sign-in` all redirect here. Auth.js `pages.signIn`
// points here. Three render modes:
//   - ?oauth=<carrier>  → brand-new-Google-user role picker (6.5d), after server-side carrier
//                          verification; invalid/expired carrier → restart notice.
//   - default            → method-first entry (Google + email/password), all paths handled by
//                          <AuthEntry/>.
//   - ?error / ?verified → notices (e.g. oauth_link_denied deny notice; email-verified success).
const mapSignInPageError = (error: string): string => {
  // Step 6.5d — safe-link fail-closed deny notice. Deliberately non-leaking: it does NOT reveal
  // whether an account exists for the Google email or why linking was refused.
  if (error === "oauth_link_denied") {
    return "Masuk dengan Google tidak dapat diselesaikan untuk email ini. Jika Anda sudah punya akun, masuk dengan metode yang terdaftar (mis. email & password).";
  }
  if (error === "oauth_session_mismatch") {
    return "Anda sudah masuk dengan akun lain. Keluar dulu lalu coba lagi masuk dengan Google.";
  }
  // 6.5-HARDENING.1 — single-use OAuth carrier (surfaced here only if a finalize error arrives via a
  // full redirect; the in-page role picker maps it directly).
  if (error === "oauth_carrier_replayed" || error === "oauth_carrier_unavailable") {
    return "Sesi pendaftaran Google ini tidak dapat digunakan lagi. Silakan mulai lagi masuk dengan Google.";
  }
  // 6.5-HARDENING.1 — failed-login lockout.
  if (error.includes("RATE_LIMITED")) {
    return "Terlalu banyak percobaan login gagal. Tunggu beberapa menit sebelum mencoba lagi.";
  }
  if (error.includes("EMAIL_NOT_VERIFIED")) {
    return "Login ditolak karena email belum diverifikasi. Cek inbox/spam lalu klik tautan verifikasi.";
  }
  if (error.includes("INVALID_CREDENTIALS") || error === "CredentialsSignin") {
    return "Login gagal karena email atau password tidak cocok. Periksa kembali data login Anda.";
  }
  if (error === "AccessDenied") {
    return "Akses ditolak karena sesi Anda tidak valid. Login ulang dengan akun yang benar.";
  }
  if (error === "Configuration") {
    return "Login gagal karena konfigurasi autentikasi belum lengkap. Hubungi admin sistem.";
  }
  return `Login gagal karena ${error}. Coba ulang atau hubungi admin jika masalah berlanjut.`;
};

export default async function LoginPage(props: {
  searchParams?: Promise<{
    error?: string;
    verified?: string;
    email?: string;
    callbackUrl?: string;
    oauth?: string;
    invite?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const oauthCarrier = searchParams?.oauth;

  // Brand-new-Google-user landing (6.5d, relocated here at 6.5d.1). Verify the HMAC carrier
  // server-side; valid → role picker (account created only on role selection); invalid/expired →
  // restart notice.
  if (oauthCarrier) {
    const claims = verifyGoogleIdentityCarrier(oauthCarrier);

    if (!claims) {
      return (
        <AuthPageFrame
          eyebrow="Sesi akses"
          title="Mulai kembali dengan sesi yang aman."
          description="Tautan pendaftaran Google bersifat terbatas dan tidak dapat digunakan setelah kedaluwarsa."
        >
          <div className="auth-state stack-md">
            <span className="auth-state-icon" data-tone="error" aria-hidden="true">
              !
            </span>
            <div className="stack-xs">
              <h1>Sesi pendaftaran tidak valid</h1>
              <p>
                Sesi pendaftaran Google sudah kedaluwarsa atau tidak valid. Silakan mulai lagi dari
                halaman masuk.
              </p>
            </div>
            <Link className="ui-button" data-variant="primary" data-size="md" href="/auth/login">
              Kembali ke halaman masuk
            </Link>
          </div>
        </AuthPageFrame>
      );
    }

    return <OAuthRolePicker carrier={oauthCarrier} email={claims.email} />;
  }

  const error = searchParams?.error;
  const verified = searchParams?.verified === "1";
  const callbackUrl = searchParams?.callbackUrl;

  // Step 6.5e — claim-signup link (?invite=<rawToken> from a pending_claim invite email). Resolve
  // the token to the invited email server-side and prefill it, so the new account is created with
  // the exact address claim-at-signup matches. Falls back to ?email= when no invite token is given.
  // Only `pending_claim` invites resolve here — a token never reveals an existing user's email.
  let email = searchParams?.email;
  if (searchParams?.invite) {
    const invitedEmail = await resolveClaimInviteEmailByToken(searchParams.invite, getDb());
    if (invitedEmail) {
      email = invitedEmail;
    }
  }

  return (
    <AuthPageFrame
      eyebrow="Akses terarah"
      title="Satu akun untuk menemukan dan mengelola peluang."
      description="Pilih metode masuk terlebih dahulu. Kami akan menuntun langkah berikutnya tanpa mencampur peran atau identitas akun."
    >
      <div className="stack-md">
        <AuthEntry
          googleEnabled={isGoogleAuthConfigured}
          verificationEnabled={isEmailAuthConfigured}
          callbackUrl={callbackUrl}
          initialEmail={email}
          verifiedNotice={verified}
        />
        {error ? (
          <p className="feedback" data-tone="error">
            {mapSignInPageError(error)}
          </p>
        ) : null}
      </div>
    </AuthPageFrame>
  );
}
