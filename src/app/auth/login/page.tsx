import { SignInForm } from "@/components/auth/sign-in-form";
import { isEmailAuthConfigured } from "@/server/auth/auth.config";

// Login entry (F2, Step 6.5b). Renders the auth shell in login mode. The register view lives at
// /auth/register; the in-form toggle navigates between the two routes so the URL always reflects
// the active view. Auth.js `pages.signIn` points here; old /auth/sign-in redirects here.
const mapSignInPageError = (error: string): string => {
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
  }>;
}) {
  const searchParams = await props.searchParams;
  const error = searchParams?.error;
  const verified = searchParams?.verified === "1";
  const email = searchParams?.email;
  const callbackUrl = searchParams?.callbackUrl;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-12">
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 md:p-6">
        <SignInForm
          verificationEnabled={isEmailAuthConfigured}
          verified={verified}
          initialEmail={email}
          callbackUrl={callbackUrl}
          initialMode="login"
        />
        {error ? <p className="mt-4 text-xs text-rose-700">{mapSignInPageError(error)}</p> : null}
      </section>
    </main>
  );
}
