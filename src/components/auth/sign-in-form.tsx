"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { PENDING_PROMPT_KEY } from "@/components/auth/second-role-prompt-modal";

type SignInFormProps = {
  verificationEnabled: boolean;
  initialEmail?: string;
  verified?: boolean;
  callbackUrl?: string;
  // F2 (Step 6.5b): which view this mount renders. /auth/login → "login", /auth/register →
  // "register". The toggle navigates between the two routes so the URL always reflects the view.
  initialMode?: "login" | "register";
};

type AuthApiError = {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
};

const parseApiError = async (response: Response): Promise<AuthApiError | null> => {
  try {
    const payload = (await response.json()) as {
      error?: AuthApiError;
    };

    return payload.error ?? null;
  } catch {
    return null;
  }
};

const mapCredentialsError = (error: string | null | undefined): string => {
  const normalizedError = error?.toUpperCase() ?? "";

  if (!error) {
    return "Login gagal karena server tidak menerima detail error. Coba cek ulang email dan password Anda.";
  }

  if (normalizedError.includes("EMAIL_NOT_VERIFIED")) {
    return "Login ditolak karena email akun ini belum diverifikasi. Buka inbox/spam, klik tautan verifikasi, lalu login kembali.";
  }

  if (normalizedError.includes("INVALID_CREDENTIALS")) {
    return "Login gagal karena email atau password tidak cocok dengan akun terdaftar. Pastikan email benar dan gunakan password yang sesuai.";
  }

  if (normalizedError.includes("INVALID_PASSWORD")) {
    return "Login gagal karena format password tidak valid. Gunakan password 8-72 karakter sesuai saat pendaftaran.";
  }

  if (normalizedError.includes("INVALID_EMAIL")) {
    return "Login gagal karena format email tidak valid. Gunakan format email yang benar, contoh `nama@kampus.ac.id`.";
  }

  return `Login gagal karena ${error}. Periksa data Anda lalu coba lagi.`;
};

const mapApiErrorToMessage = (apiError: AuthApiError | null): string => {
  if (!apiError?.code) {
    return (
      apiError?.message ??
      "Permintaan gagal diproses karena server tidak mengembalikan alasan yang jelas. Coba ulang beberapa saat lagi."
    );
  }

  switch (apiError.code) {
    case "invalid_name":
      return "Pendaftaran ditolak karena nama tidak valid. Isi nama lengkap 2-120 karakter tanpa hanya spasi.";
    case "invalid_email":
      return "Permintaan ditolak karena format email tidak valid. Gunakan format email yang benar, contoh `nama@kampus.ac.id`.";
    case "invalid_password":
      return "Permintaan ditolak karena password tidak memenuhi syarat. Gunakan password 8-72 karakter.";
    case "email_exists":
      return "Email ini sudah terdaftar sebagai akun aktif. Gunakan mode Login atau reset password jika lupa.";
    case "verification_required":
      return "Tidak ada pendaftaran yang perlu diverifikasi untuk email ini. Pastikan Anda mendaftar terlebih dahulu dengan email yang sama.";
    case "verification_email_failed":
      return "Akun sudah dibuat tetapi email verifikasi gagal dikirim. Coba Kirim Ulang Verifikasi dalam beberapa saat.";
    case "invalid_payload":
      return "Permintaan tidak valid karena format data tidak sesuai. Muat ulang halaman lalu isi formulir kembali.";
    default:
      return (
        apiError.message ??
        "Permintaan gagal diproses karena alasan yang tidak dikenali. Coba lagi atau hubungi admin."
      );
  }
};

export const SignInForm = ({
  verificationEnabled,
  initialEmail,
  verified,
  callbackUrl,
  initialMode,
}: SignInFormProps) => {
  // The view is fixed by the route that rendered this form (/auth/login vs /auth/register).
  // Switching views is a URL navigation via the toggle links below, not local state.
  const mode: "login" | "register" = initialMode ?? (verified ? "login" : "register");
  const cbSuffix = callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : "";
  const loginHref = `/auth/login${cbSuffix}`;
  const registerHref = `/auth/register${cbSuffix}`;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(
    initialEmail ?? null,
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(
    verified ? "Email berhasil diverifikasi. Silakan login dengan password Anda." : null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [loginEmail, setLoginEmail] = useState(initialEmail ?? "");
  const [loginPassword, setLoginPassword] = useState("");

  const onSubmitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!loginEmail.trim() || !loginPassword.trim()) {
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const result = await signIn("credentials", {
        email: loginEmail.trim().toLowerCase(),
        password: loginPassword,
        // After sign-in, land on the homepage. The second-role-prompt modal (mounted globally
        // in providers.tsx) decides on its own whether to surface based on live session state.
        callbackUrl: callbackUrl ?? "/",
        redirect: false,
      });

      if (result?.ok && result.url) {
        // Mark this sign-in as "fresh" so the second-role-prompt modal knows to open exactly
        // once on the destination page. Already-logged-in users opening the app don't set
        // this flag and therefore don't see the modal automatically.
        try {
          window.sessionStorage.setItem(PENDING_PROMPT_KEY, "1");
        } catch {
          /* sessionStorage unavailable — modal will simply not auto-open this session */
        }
        window.location.assign(result.url);
        return;
      }

      const mappedMessage = mapCredentialsError(result?.error);
      setErrorMessage(mappedMessage);

      if (mappedMessage.toLowerCase().includes("verifikasi")) {
        setPendingVerificationEmail(loginEmail.trim().toLowerCase());
      }
    } catch {
      setErrorMessage(
        "Login gagal karena gangguan koneksi atau server. Periksa internet Anda lalu coba kembali.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const onResendVerification = async () => {
    if (!pendingVerificationEmail) {
      return;
    }

    setIsResending(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/v1/auth/register/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: pendingVerificationEmail,
        }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setErrorMessage(mapApiErrorToMessage(apiError));
        return;
      }

      setStatusMessage("Email verifikasi baru berhasil dikirim.");
    } catch {
      setErrorMessage(
        "Gagal mengirim ulang verifikasi karena koneksi bermasalah atau layanan email sedang sibuk. Coba lagi beberapa saat.",
      );
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="relative flex min-h-[460px] flex-col overflow-hidden rounded-2xl bg-gradient-to-b from-[#3a4de5] to-[#2336c7] p-5 text-white">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">Lombakita</p>
        <h3 className="mt-1 text-xl font-semibold">Account</h3>

        <ul className="mt-6 space-y-4 text-sm">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/70 text-xs font-semibold">
              1
            </span>
            <span className="font-medium">Account</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/50 text-xs font-semibold text-white/90">
              2
            </span>
            <span className="font-medium">Verify</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/50 text-xs font-semibold text-white/90">
              3
            </span>
            <span className="font-medium">Login</span>
          </li>
        </ul>

        <div
          aria-hidden
          className="pointer-events-none absolute -left-8 bottom-7 h-28 w-28 rounded-full bg-[#ffd3a6]/80"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute right-4 top-6 h-20 w-20 rounded-full border border-white/35"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 right-0 h-24 w-44 rounded-tl-[80px] bg-[#ff9bb0]/75"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-14 left-20 h-10 w-20 rounded-full border border-white/30"
        />

        <div className="relative z-10 mt-auto pt-6">
          <div
            className="grid grid-cols-2 rounded-full bg-white/18 p-1 backdrop-blur-sm"
            role="group"
            aria-label="Auth mode toggle"
          >
            <Link
              href={registerHref}
              className={`rounded-full px-4 py-2 text-center text-sm font-medium transition-colors ${
                mode === "register" ? "bg-white text-[#2336c7]" : "text-white/85 hover:text-white"
              }`}
              aria-current={mode === "register" ? "page" : undefined}
            >
              Register
            </Link>
            <Link
              href={loginHref}
              className={`rounded-full px-4 py-2 text-center text-sm font-medium transition-colors ${
                mode === "login" ? "bg-white text-[#2336c7]" : "text-white/85 hover:text-white"
              }`}
              aria-current={mode === "login" ? "page" : undefined}
            >
              Login
            </Link>
          </div>
        </div>
      </aside>

      <section className="flex min-h-[460px] flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        {mode === "register" ? (
          <div className="flex h-full flex-col">
            <h2 className="text-xl font-semibold text-zinc-900">Buat akun baru</h2>
            <p className="mt-2 text-sm text-zinc-500">Pilih peran untuk mendaftar.</p>

            <div className="mt-6 space-y-3">
              <Link
                href="/auth/register?as=candidate"
                className="block rounded-xl border border-zinc-200 p-4 text-sm font-medium text-zinc-900 hover:border-zinc-400"
              >
                Daftar sebagai Kandidat
                <span className="mt-0.5 block text-xs font-normal text-zinc-500">
                  Mahasiswa atau lulusan yang mencari kompetisi, beasiswa, dan peluang lain.
                </span>
              </Link>
              <Link
                href="/auth/register?as=recruiter"
                className="block rounded-xl border border-zinc-200 p-4 text-sm font-medium text-zinc-900 hover:border-zinc-400"
              >
                Daftar sebagai Recruiter
                <span className="mt-0.5 block text-xs font-normal text-zinc-500">
                  Perwakilan institusi yang ingin menerbitkan dan mengelola peluang.
                </span>
              </Link>
            </div>

            {!verificationEnabled ? (
              <p className="mt-4 text-xs text-amber-700">
                Resend belum lengkap (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`).
              </p>
            ) : null}
          </div>
        ) : (
          <form onSubmit={onSubmitLogin} className="flex h-full flex-col">
            <h2 className="text-xl font-semibold text-zinc-900">Login akun</h2>

            <div className="mt-3 space-y-3">
              <label className="block text-sm font-medium" htmlFor="login-email">
                Email
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                required
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
                placeholder="you@university.ac.id"
              />

              <label className="block text-sm font-medium" htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                required
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
                placeholder="Masukkan password"
              />
            </div>

            <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-4">
              {pendingVerificationEmail ? (
                <button
                  type="button"
                  disabled={isResending || !verificationEnabled}
                  onClick={() => {
                    void onResendVerification();
                  }}
                  className="rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isResending ? "Mengirim..." : "Kirim ulang verifikasi"}
                </button>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Memverifikasi..." : "Login"}
              </button>
            </div>
          </form>
        )}

        {statusMessage ? <p className="mt-4 text-xs text-emerald-700">{statusMessage}</p> : null}
        {errorMessage ? <p className="mt-2 text-xs text-rose-700">{errorMessage}</p> : null}

        {!verificationEnabled ? (
          <p className="mt-4 text-xs text-amber-700">
            Resend belum lengkap (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`).
          </p>
        ) : null}
      </section>
    </div>
  );
};
