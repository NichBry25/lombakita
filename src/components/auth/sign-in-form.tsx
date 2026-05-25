"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";

type SignInFormProps = {
  verificationEnabled: boolean;
  initialEmail?: string;
  verified?: boolean;
  callbackUrl?: string;
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
}: SignInFormProps) => {
  const [mode, setMode] = useState<"login" | "register">(verified ? "login" : "register");
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

  const [registerName, setRegisterName] = useState("");
  const [registerEmail, setRegisterEmail] = useState(initialEmail ?? "");
  const [registerPassword, setRegisterPassword] = useState("");

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
        // Step 4.0b — route through the post-login decision page so single-role accounts hit
        // the second-role prompt before reaching a dashboard. The decision page redirects on
        // to the right destination based on live verification state.
        callbackUrl: callbackUrl ?? "/auth/post-login",
        redirect: false,
      });

      if (result?.ok && result.url) {
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

  const onSubmitRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!verificationEnabled) {
      setErrorMessage(
        "Pendaftaran sementara tidak tersedia karena konfigurasi verifikasi email belum lengkap.",
      );
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: registerName,
          email: registerEmail,
          password: registerPassword,
        }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setErrorMessage(mapApiErrorToMessage(apiError));
        return;
      }

      const payload = (await response.json()) as {
        registration: {
          email: string;
          verificationRequired: boolean;
          alreadyVerified: boolean;
        };
      };

      setPendingVerificationEmail(payload.registration.email);
      setLoginEmail(payload.registration.email);
      setRegisterEmail(payload.registration.email);
      setRegisterPassword("");

      if (payload.registration.alreadyVerified) {
        setMode("login");
        setStatusMessage(
          "Email ini sudah pernah diverifikasi. Password telah diperbarui, silakan login.",
        );
        return;
      }

      setStatusMessage(
        "Pendaftaran berhasil. Kami telah mengirim email verifikasi melalui Resend. Buka inbox Anda untuk aktivasi akun.",
      );
    } catch {
      setErrorMessage(
        "Pendaftaran gagal karena gangguan koneksi atau server. Periksa internet Anda lalu coba lagi.",
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
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                mode === "register" ? "bg-white text-[#2336c7]" : "text-white/85 hover:text-white"
              }`}
              aria-pressed={mode === "register"}
            >
              Register
            </button>
            <button
              type="button"
              onClick={() => setMode("login")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                mode === "login" ? "bg-white text-[#2336c7]" : "text-white/85 hover:text-white"
              }`}
              aria-pressed={mode === "login"}
            >
              Login
            </button>
          </div>
        </div>
      </aside>

      <section className="flex min-h-[460px] flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        {mode === "register" ? (
          <form onSubmit={onSubmitRegister} className="flex h-full flex-col">
            <h2 className="text-xl font-semibold text-zinc-900">Buat akun mahasiswa</h2>

            <div className="mt-3 space-y-3">
              <label className="block text-sm font-medium" htmlFor="register-name">
                Nama lengkap
              </label>
              <input
                id="register-name"
                name="name"
                type="text"
                required
                value={registerName}
                onChange={(event) => setRegisterName(event.target.value)}
                className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
                placeholder="Contoh: Nadya Kartika"
              />

              <label className="block text-sm font-medium" htmlFor="register-email">
                Email
              </label>
              <input
                id="register-email"
                name="email"
                type="email"
                required
                value={registerEmail}
                onChange={(event) => setRegisterEmail(event.target.value)}
                className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
                placeholder="you@university.ac.id"
              />

              <label className="block text-sm font-medium" htmlFor="register-password">
                Password
              </label>
              <input
                id="register-password"
                name="password"
                type="password"
                required
                minLength={8}
                value={registerPassword}
                onChange={(event) => setRegisterPassword(event.target.value)}
                className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
                placeholder="Minimal 8 karakter"
              />
            </div>

            <div className="mt-auto flex justify-end pt-4">
              <button
                type="submit"
                disabled={isSubmitting || !verificationEnabled}
                className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Memproses..." : "Daftar"}
              </button>
            </div>
          </form>
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
