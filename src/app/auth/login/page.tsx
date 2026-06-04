import Link from "next/link";
import { AuthEntry } from "@/components/auth/auth-entry";
import { OAuthRolePicker } from "@/components/auth/oauth-role-picker";
import { isEmailAuthConfigured, isGoogleAuthConfigured } from "@/server/auth/auth.config";
import { verifyGoogleIdentityCarrier } from "@/server/auth/oauth-identity-carrier";

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
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-20">
          <h1 className="text-2xl font-semibold tracking-tight">Sesi pendaftaran tidak valid</h1>
          <p className="text-zinc-600">
            Sesi pendaftaran Google sudah kedaluwarsa atau tidak valid. Silakan mulai lagi dari
            halaman masuk.
          </p>
          <p className="text-sm">
            <Link className="underline" href="/auth/login">
              Kembali ke halaman masuk
            </Link>
          </p>
        </main>
      );
    }

    return <OAuthRolePicker carrier={oauthCarrier} email={claims.email} />;
  }

  const error = searchParams?.error;
  const verified = searchParams?.verified === "1";
  const email = searchParams?.email;
  const callbackUrl = searchParams?.callbackUrl;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-6 py-12">
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 md:p-6">
        <AuthEntry
          googleEnabled={isGoogleAuthConfigured}
          verificationEnabled={isEmailAuthConfigured}
          callbackUrl={callbackUrl}
          initialEmail={email}
          verifiedNotice={verified}
        />
        {error ? <p className="mt-4 text-xs text-rose-700">{mapSignInPageError(error)}</p> : null}
      </section>
    </main>
  );
}
