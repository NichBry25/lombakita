"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import { PENDING_PROMPT_KEY } from "@/components/auth/second-role-prompt-modal";

// Step 6.5d.1 — method-first single-page auth entry. Replaces the 6.5b two-page login/register
// toggle. The user first picks a sign-in method; then:
//   - Google: full redirect; the signIn callback decides everything server-side (existing →
//     signed in; new → /auth/login?oauth=<carrier> role picker; suspended → /suspended; unverified
//     same-email → deny notice). Built in 6.5d, reused unchanged here.
//   - Email & password: the user enters email + password. We classify the email server-side
//     (/api/v1/auth/identify) and branch:
//       • verified  → attempt the password sign-in (path a). Wrong/absent password → generic
//                     "email atau password salah" (a Google-only account lands here too).
//       • unverified→ show "email belum diverifikasi" + resend; never offer signup (would 23505).
//       • none      → role picker + name; create the account via the existing register endpoint,
//                     which sends the Resend verification (path b). Account usable on verification.
// Suspension is enforced in `authorize` (6.5c) regardless of this shell; we route the
// ACCOUNT_SUSPENDED signal to /suspended exactly as the old form did.

type AuthEntryProps = {
  googleEnabled: boolean;
  verificationEnabled: boolean;
  callbackUrl?: string;
  initialEmail?: string;
  // True when arriving from the email-verification success redirect (?verified=1). Opens the
  // credentials method directly with a confirmation message.
  verifiedNotice?: boolean;
};

type Method = "choose" | "credentials";
type CredentialStage = "entry" | "verifyNotice" | "signup";

const SIGNUP_ROLES = [
  {
    role: "candidate" as const,
    label: "Daftar sebagai Kandidat",
    hint: "Mahasiswa atau lulusan yang mencari kompetisi, beasiswa, dan peluang lain.",
  },
  {
    role: "recruiter" as const,
    label: "Daftar sebagai Recruiter",
    hint: "Perwakilan institusi yang ingin menerbitkan dan mengelola peluang.",
  },
];

export const AuthEntry = ({
  googleEnabled,
  verificationEnabled,
  callbackUrl,
  initialEmail,
  verifiedNotice,
}: AuthEntryProps) => {
  const [method, setMethod] = useState<Method>(verifiedNotice ? "credentials" : "choose");
  const [stage, setStage] = useState<CredentialStage>("entry");

  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(
    verifiedNotice ? "Email berhasil diverifikasi. Silakan masuk dengan password Anda." : null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetMessages = () => {
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const startGoogle = () => {
    void signIn("google", { callbackUrl: callbackUrl ?? "/" });
  };

  const finishLogin = (url: string) => {
    // Mark this sign-in as "fresh" so the global second-role-prompt modal opens once on the
    // destination page (mirrors the prior login form behaviour).
    try {
      window.sessionStorage.setItem(PENDING_PROMPT_KEY, "1");
    } catch {
      /* sessionStorage unavailable — modal simply will not auto-open this session */
    }
    window.location.assign(url);
  };

  const attemptCredentialSignIn = async () => {
    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      callbackUrl: callbackUrl ?? "/",
      redirect: false,
    });

    // 6.5c — suspended accounts are blocked in `authorize`; route the distinct signal to the
    // public /suspended page. No second-role flag is set on this branch.
    if (result?.error?.toUpperCase().includes("ACCOUNT_SUSPENDED")) {
      window.location.assign("/suspended");
      return;
    }

    if (result?.ok && result.url) {
      finishLogin(result.url);
      return;
    }

    // Defensive: a `verified` classification should not yield email_not_verified, but if it does,
    // surface the verify notice rather than a generic error.
    if (result?.error?.toUpperCase().includes("EMAIL_NOT_VERIFIED")) {
      setStage("verifyNotice");
      return;
    }

    // Show a "did you use Google?" hint only when Google is available — this is the verified path,
    // so an account exists; a Google-only account has no password and always reaches this branch.
    setErrorMessage(
      googleEnabled
        ? "Login gagal karena email atau password salah. Apakah Anda pernah masuk dengan Google? Jika ya, klik 'Ganti metode' lalu pilih 'Lanjut dengan Google'."
        : "Login gagal karena email atau password salah. Periksa kembali data Anda.",
    );
  };

  const onSubmitEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      return;
    }

    setIsSubmitting(true);
    resetMessages();

    try {
      const response = await fetch("/api/v1/auth/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      if (!response.ok) {
        setErrorMessage("Format email tidak valid. Gunakan format seperti nama@kampus.ac.id.");
        return;
      }

      const payload = (await response.json()) as { state?: "none" | "unverified" | "verified" };

      if (payload.state === "verified") {
        await attemptCredentialSignIn();
        return;
      }

      if (payload.state === "unverified") {
        setStage("verifyNotice");
        return;
      }

      // state === "none" — no account for this email; offer the role picker.
      setStage("signup");
    } catch {
      setErrorMessage("Terjadi gangguan koneksi. Coba lagi beberapa saat.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onResend = async () => {
    if (!email.trim()) {
      return;
    }
    setIsResending(true);
    resetMessages();

    try {
      const response = await fetch("/api/v1/auth/register/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      if (!response.ok) {
        setErrorMessage("Gagal mengirim ulang verifikasi. Coba lagi beberapa saat.");
        return;
      }

      setStatusMessage("Email verifikasi baru telah dikirim. Buka inbox/spam Anda.");
    } catch {
      setErrorMessage("Gagal mengirim ulang verifikasi karena gangguan koneksi.");
    } finally {
      setIsResending(false);
    }
  };

  const onPickSignupRole = async (role: "candidate" | "recruiter") => {
    if (!verificationEnabled) {
      setErrorMessage(
        "Pendaftaran tidak tersedia karena konfigurasi email verifikasi (Resend) belum lengkap.",
      );
      return;
    }
    if (name.trim().length < 2) {
      setErrorMessage("Isi nama lengkap (minimal 2 karakter) untuk mendaftar.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("Password dan konfirmasi password tidak cocok. Coba lagi.");
      return;
    }

    setIsSubmitting(true);
    resetMessages();

    try {
      const response = await fetch(`/api/v1/auth/register?as=${encodeURIComponent(role)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (payload?.error?.code === "email_exists") {
          setErrorMessage("Akun untuk email ini sudah ada. Silakan masuk, bukan mendaftar.");
        } else {
          setErrorMessage(
            payload?.error?.message ?? "Pendaftaran gagal. Periksa data Anda lalu coba lagi.",
          );
        }
        return;
      }

      setStatusMessage(
        "Pendaftaran berhasil. Kami telah mengirim email verifikasi — buka inbox Anda untuk aktivasi, lalu masuk.",
      );
    } catch {
      setErrorMessage("Pendaftaran gagal karena gangguan koneksi. Coba lagi beberapa saat.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const backToChoose = () => {
    setMethod("choose");
    setStage("entry");
    resetMessages();
  };

  const backToEntry = () => {
    setStage("entry");
    setConfirmPassword("");
    resetMessages();
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-zinc-900">Masuk atau daftar</h1>
        <p className="text-sm text-zinc-500">Pilih cara Anda ingin melanjutkan.</p>
      </header>

      {method === "choose" ? (
        <div className="space-y-3">
          {googleEnabled ? (
            <button
              type="button"
              onClick={startGoogle}
              className="w-full rounded-xl border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-800 hover:border-zinc-400"
            >
              Lanjut dengan Google
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              resetMessages();
              setMethod("credentials");
            }}
            className="w-full rounded-xl border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-800 hover:border-zinc-400"
          >
            Lanjut dengan Email & Password
          </button>
        </div>
      ) : null}

      {method === "credentials" && stage === "entry" ? (
        <form onSubmit={onSubmitEntry} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="auth-email">
            Email
          </label>
          <input
            id="auth-email"
            name="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
            placeholder="you@university.ac.id"
          />

          <label className="block text-sm font-medium" htmlFor="auth-password">
            Password
          </label>
          <input
            id="auth-password"
            name="password"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
            placeholder="Masukkan password"
          />

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={backToChoose}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
            >
              Ganti metode
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? "Memproses..." : "Lanjut"}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Belum punya akun? Masukkan email &amp; password, lalu pilih peran di langkah berikutnya.
          </p>
        </form>
      ) : null}

      {method === "credentials" && stage === "verifyNotice" ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-700">
            Email <span className="font-medium">{email}</span> belum diverifikasi. Buka tautan
            verifikasi di inbox/spam Anda, atau kirim ulang di bawah ini.
          </p>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={backToEntry}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
            >
              Kembali
            </button>
            <button
              type="button"
              disabled={isResending || !verificationEnabled}
              onClick={() => {
                void onResend();
              }}
              className="rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isResending ? "Mengirim..." : "Kirim ulang verifikasi"}
            </button>
          </div>
        </div>
      ) : null}

      {method === "credentials" && stage === "signup" ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-700">
            Belum ada akun untuk <span className="font-medium">{email}</span>. Lengkapi nama dan
            pilih peran untuk mendaftar.
          </p>

          <label className="block text-sm font-medium" htmlFor="auth-name">
            Nama lengkap
          </label>
          <input
            id="auth-name"
            name="name"
            type="text"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
            placeholder="Nama Anda"
          />

          <label className="block text-sm font-medium" htmlFor="auth-confirm-password">
            Konfirmasi password
          </label>
          <input
            id="auth-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm"
            placeholder="Ulangi password Anda"
          />

          <div className="space-y-2 pt-1">
            {SIGNUP_ROLES.map((entry) => (
              <button
                key={entry.role}
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  void onPickSignupRole(entry.role);
                }}
                className="block w-full rounded-xl border border-zinc-200 p-4 text-left text-sm font-medium text-zinc-900 hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Membuat akun..." : entry.label}
                <span className="mt-0.5 block text-xs font-normal text-zinc-500">{entry.hint}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={backToEntry}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
          >
            Kembali
          </button>

          {!verificationEnabled ? (
            <p className="text-xs text-amber-700">
              Pendaftaran email belum tersedia (`RESEND_API_KEY`, `AUTH_EMAIL_FROM` belum lengkap).
            </p>
          ) : null}
        </div>
      ) : null}

      {statusMessage ? <p className="text-xs text-emerald-700">{statusMessage}</p> : null}
      {errorMessage ? <p className="text-xs text-rose-700">{errorMessage}</p> : null}
    </div>
  );
};
