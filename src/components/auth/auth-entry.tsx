"use client";

import { FormEvent, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Button, SelectField, usePageTransition } from "@/components/ui";
import { AssentNotice } from "@/components/legal/assent-notice";
import { useToast } from "@/components/ui/primitives";
import { PENDING_PROMPT_KEY } from "@/components/auth/second-role-prompt-modal";

// Method-first single-page auth entry. Replaces the earlier two-page login/register
// toggle. The user first picks a sign-in method; then:
//   - Google: full redirect; the signIn callback decides everything server-side (existing →
//     signed in; new → /auth/login?oauth=<carrier> role picker; suspended → /suspended; unverified
//     same-email → deny notice).
//   - Email & password: the user enters email + password. We classify the email server-side
//     (/api/v1/auth/identify) and branch:
//       • verified  → attempt the password sign-in (path a). Wrong/absent password → generic
//                     "email atau password salah" (a Google-only account lands here too).
//       • unverified→ show "email belum diverifikasi" + resend; never offer signup (would 23505).
//       • none      → role picker + name; create the account via the existing register endpoint,
//                     which sends the Resend verification (path b). Account usable on verification.
// Suspension is enforced in `authorize` regardless of this shell; we route the
// ACCOUNT_SUSPENDED signal to /suspended.

type AuthEntryProps = {
  googleEnabled: boolean;
  verificationEnabled: boolean;
  callbackUrl?: string;
  initialEmail?: string;
  // True when arriving from the email-verification success redirect (?verified=1). Opens the
  // credentials method directly with a confirmation message.
  verifiedNotice?: boolean;
  // Server-resolved message for a `?error=` query param (e.g. a failed sign-in redirect, or the
  // safe-link deny notice). Fired as a toast once on mount.
  initialErrorMessage?: string;
};

type Method = "choose" | "credentials";
type CredentialStage =
  | "entry"
  | "verifyNotice"
  | "signup"
  | "candidateOnboarding"
  | "recruiterOnboarding";

const SIGNUP_ROLES = [
  {
    role: "candidate" as const,
    label: "Daftar sebagai kandidat",
    hint: "Siapa pun yang mencari kompetisi, beasiswa, dan peluang lain.",
  },
  {
    role: "recruiter" as const,
    label: "Daftar sebagai rekruter",
    hint: "Perwakilan institusi yang ingin menerbitkan dan mengelola peluang.",
  },
];

// Candidate onboarding option list. Values must match the `candidate_occupation` DB enum exactly.
const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

export const AuthEntry = ({
  googleEnabled,
  verificationEnabled,
  callbackUrl,
  initialEmail,
  verifiedNotice,
  initialErrorMessage,
}: AuthEntryProps) => {
  const [method, setMethod] = useState<Method>(verifiedNotice ? "credentials" : "choose");
  const [stage, setStage] = useState<CredentialStage>("entry");

  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");

  // Candidate onboarding fields — collected on the candidateOnboarding stage, right after the
  // candidate role is chosen, and submitted together with the account creation request.
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [occupation, setOccupation] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // Recruiter onboarding fields — collected on the recruiterOnboarding stage, right after the
  // recruiter role is chosen, and submitted together with the account creation request. Mobile is
  // required; the corporate email is optional and, when a corporate domain, speeds up review.
  const [recruiterMobile, setRecruiterMobile] = useState("");
  const [recruiterCorporateEmail, setRecruiterCorporateEmail] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const { begin: beginPageTransition } = usePageTransition();
  const { addToast } = useToast();

  useEffect(() => {
    if (verifiedNotice) {
      addToast({
        type: "success",
        message: "Email berhasil diverifikasi. Silakan masuk dengan password Anda.",
      });
    }
    if (initialErrorMessage) {
      addToast({ type: "error", message: initialErrorMessage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stage === "signup" && !verificationEnabled) {
      addToast({
        type: "warning",
        message: "Pendaftaran email sedang tidak tersedia. Coba lagi nanti.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const startGoogle = () => {
    // Hands off to Google's consent screen. That is a full document navigation, so the blocking
    // screen stays up until the browser leaves this page.
    beginPageTransition("Menghubungkan ke Google…");
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
    beginPageTransition("Menyiapkan akun Anda…");
    window.location.assign(url);
  };

  const attemptCredentialSignIn = async () => {
    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      callbackUrl: callbackUrl ?? "/",
      redirect: false,
    });

    // Suspended accounts are blocked in `authorize`; route the distinct signal to the
    // public /suspended page. No second-role flag is set on this branch.
    if (result?.error?.toUpperCase().includes("ACCOUNT_SUSPENDED")) {
      beginPageTransition("Mengalihkan…");
      window.location.assign("/suspended");
      return;
    }

    // Failed-attempt lockout. `authorize` throws RATE_LIMITED once too many failed
    // logins for this IP+email accumulate; surface a distinct, non-enumerating message.
    if (result?.error?.toUpperCase().includes("RATE_LIMITED")) {
      addToast({
        type: "error",
        message:
          "Terlalu banyak percobaan login gagal. Tunggu beberapa menit sebelum mencoba lagi.",
      });
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
    addToast({
      type: "error",
      message: googleEnabled
        ? "Login gagal karena email atau password salah. Apakah Anda pernah masuk dengan Google? Jika ya, klik 'Ganti metode' lalu pilih 'Lanjut dengan Google'."
        : "Login gagal karena email atau password salah. Periksa kembali data Anda.",
    });
  };

  const onSubmitEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/v1/auth/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      // The identify endpoint is per-IP rate-limited; a 429 is distinct from a
      // validation failure and must not be reported as a bad email format.
      if (response.status === 429) {
        addToast({
          type: "error",
          message: "Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.",
        });
        return;
      }

      if (!response.ok) {
        addToast({
          type: "error",
          message: "Format email tidak valid. Gunakan format seperti nama@kampus.ac.id.",
        });
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
      addToast({ type: "error", message: "Terjadi gangguan koneksi. Coba lagi beberapa saat." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const onResend = async () => {
    if (!email.trim()) {
      return;
    }
    setIsResending(true);

    try {
      const response = await fetch("/api/v1/auth/register/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      if (!response.ok) {
        addToast({
          type: "error",
          message: "Gagal mengirim ulang verifikasi. Coba lagi beberapa saat.",
        });
        return;
      }

      addToast({
        type: "success",
        message: "Email verifikasi baru telah dikirim. Buka inbox/spam Anda.",
      });
    } catch {
      addToast({
        type: "error",
        message: "Gagal mengirim ulang verifikasi karena gangguan koneksi.",
      });
    } finally {
      setIsResending(false);
    }
  };

  // Shared account-creation call. `candidateBody` carries the candidate onboarding fields on the
  // candidate path; it is null for recruiters.
  const registerAccount = async (
    role: "candidate" | "recruiter",
    candidateBody: Record<string, unknown> | null,
  ) => {
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/v1/auth/register?as=${encodeURIComponent(role)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          ...(candidateBody ?? {}),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (payload?.error?.code === "email_exists") {
          addToast({
            type: "error",
            message: "Akun untuk email ini sudah ada. Silakan masuk, bukan mendaftar.",
          });
        } else {
          addToast({
            type: "error",
            message:
              payload?.error?.message ?? "Pendaftaran gagal. Periksa data Anda lalu coba lagi.",
          });
        }
        return;
      }

      setStage("entry");
      addToast({
        type: "success",
        message:
          "Pendaftaran berhasil. Kami sudah mengirim email verifikasi. Buka inbox Anda untuk mengaktifkan akun, lalu masuk.",
      });
    } catch {
      addToast({
        type: "error",
        message: "Pendaftaran gagal karena gangguan koneksi. Coba lagi beberapa saat.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Validates the shared signup fields, then either advances the candidate to the onboarding form
  // or (for recruiters) creates the account immediately.
  const onPickSignupRole = (role: "candidate" | "recruiter") => {
    if (!verificationEnabled) {
      addToast({
        type: "error",
        message:
          "Pendaftaran tidak tersedia karena konfigurasi email verifikasi (Resend) belum lengkap.",
      });
      return;
    }
    if (name.trim().length < 2) {
      addToast({
        type: "error",
        message: "Isi nama lengkap (minimal 2 karakter) untuk mendaftar.",
      });
      return;
    }
    if (password !== confirmPassword) {
      addToast({
        type: "error",
        message: "Password dan konfirmasi password tidak cocok. Coba lagi.",
      });
      return;
    }

    if (role === "candidate") {
      // Prefill the candidate's declared full name from the name already entered; it stays editable.
      setFullName((current) => current || name.trim());
      setStage("candidateOnboarding");
      return;
    }

    // Recruiter also completes an onboarding form (affiliation) before the account is created; the
    // account starts sandboxed until platform ops approve it as a Trusted Recruiter.
    setFullName((current) => current || name.trim());
    setStage("recruiterOnboarding");
  };

  const onSubmitRecruiterOnboarding = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (fullName.trim().length < 2) {
      addToast({ type: "error", message: "Isi nama lengkap (minimal 2 karakter)." });
      return;
    }
    if (recruiterMobile.replace(/\D/g, "").length < 8) {
      addToast({ type: "error", message: "Isi nomor ponsel yang valid (minimal 8 digit)." });
      return;
    }

    void registerAccount("recruiter", {
      fullName: fullName.trim(),
      mobileNumber: recruiterMobile.trim(),
      corporateEmail: recruiterCorporateEmail.trim() || null,
    });
  };

  const onSubmitCandidateOnboarding = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (fullName.trim().length < 2) {
      addToast({ type: "error", message: "Isi nama lengkap (minimal 2 karakter)." });
      return;
    }
    if (phoneNumber.replace(/\D/g, "").length < 8) {
      addToast({ type: "error", message: "Isi nomor telepon yang valid (minimal 8 digit)." });
      return;
    }
    if (!occupation) {
      addToast({ type: "error", message: "Pilih status Anda saat ini." });
      return;
    }
    if (!dateOfBirth) {
      addToast({ type: "error", message: "Isi tanggal lahir Anda." });
      return;
    }

    void registerAccount("candidate", {
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      occupation,
      dateOfBirth,
    });
  };

  const backToChoose = () => {
    setMethod("choose");
    setStage("entry");
  };

  const backToEntry = () => {
    setStage("entry");
    setConfirmPassword("");
  };

  const backToSignup = () => {
    setStage("signup");
  };

  return (
    <div className="auth-entry">
      <header className="auth-entry-header">
        <h1>Masuk atau daftar</h1>
        <p>Pilih cara Anda ingin melanjutkan.</p>
      </header>

      {method === "choose" ? (
        <div className="auth-method-list">
          {googleEnabled ? (
            <button type="button" onClick={startGoogle} className="auth-method-button">
              <span className="auth-provider-mark" aria-hidden="true">
                G
              </span>
              <span>
                <strong>Lanjut dengan Google</strong>
                <small>Gunakan akun Google yang terhubung dengan email Anda.</small>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setMethod("credentials");
            }}
            className="auth-method-button"
          >
            <span className="auth-provider-mark" aria-hidden="true">
              @
            </span>
            <span>
              <strong>Lanjut dengan email &amp; password</strong>
              <small>Masuk atau buat akun dengan alamat email Anda.</small>
            </span>
          </button>
        </div>
      ) : null}

      {method === "credentials" && stage === "entry" ? (
        <form onSubmit={onSubmitEntry} className="auth-form">
          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="auth-email">
              Email
            </label>
            <input
              id="auth-email"
              name="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="form-input"
              placeholder="nama@kampus.ac.id"
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="form-input"
              placeholder="Masukkan password"
            />
          </div>

          <div className="auth-form-actions">
            <Button type="button" onClick={backToChoose} variant="ghost" size="sm">
              Ganti metode
            </Button>
            <Button type="submit" loading={isSubmitting} variant="primary" size="md">
              Lanjut
            </Button>
          </div>
          <p className="form-help">
            Belum punya akun? Masukkan email &amp; password, lalu pilih peran di langkah berikutnya.
          </p>
        </form>
      ) : null}

      {method === "credentials" && stage === "verifyNotice" ? (
        <div className="auth-stage-panel">
          <p>
            Email <span className="font-medium">{email}</span> belum diverifikasi. Buka tautan
            verifikasi di inbox/spam Anda, atau kirim ulang di bawah ini.
          </p>
          <div className="auth-form-actions">
            <Button type="button" onClick={backToEntry} variant="ghost" size="sm">
              Kembali
            </Button>
            <Button
              type="button"
              loading={isResending}
              disabled={!verificationEnabled}
              onClick={() => {
                void onResend();
              }}
              variant="outline"
              size="sm"
            >
              Kirim ulang verifikasi
            </Button>
          </div>
        </div>
      ) : null}

      {method === "credentials" && stage === "signup" ? (
        <div className="auth-stage-panel">
          <p>
            Belum ada akun untuk <span className="font-medium">{email}</span>. Lengkapi nama dan
            pilih peran untuk mendaftar.
          </p>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="auth-name">
              Nama lengkap
            </label>
            <input
              id="auth-name"
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="form-input"
              placeholder="Nama Anda"
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="auth-confirm-password">
              Konfirmasi password
            </label>
            <input
              id="auth-confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="form-input"
              placeholder="Ulangi password Anda"
            />
          </div>

          <div className="auth-role-list">
            {SIGNUP_ROLES.map((entry) => (
              <button
                key={entry.role}
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  void onPickSignupRole(entry.role);
                }}
                className="auth-role-option"
              >
                <strong>{entry.label}</strong>
                <span>{entry.hint}</span>
              </button>
            ))}
          </div>

          <AssentNotice />

          <Button type="button" onClick={backToEntry} variant="ghost" size="sm">
            Kembali
          </Button>
        </div>
      ) : null}

      {method === "credentials" && stage === "candidateOnboarding" ? (
        <form onSubmit={onSubmitCandidateOnboarding} className="auth-form">
          <p>Lengkapi data kandidat Anda. Data ini bisa diubah nanti di dasbor Anda.</p>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="candidate-full-name">
              Nama lengkap
            </label>
            <input
              id="candidate-full-name"
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="form-input"
              placeholder="Nama lengkap sesuai identitas"
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="candidate-phone">
              Nomor telepon
            </label>
            <input
              id="candidate-phone"
              type="tel"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              className="form-input"
              placeholder="Contoh: 0812xxxxxxx"
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="candidate-occupation">
              Status saat ini
            </label>
            <SelectField
              id="candidate-occupation"
              label="Status saat ini"
              value={occupation}
              placeholder="Pilih status Anda"
              options={[...OCCUPATION_OPTIONS]}
              onChange={setOccupation}
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="candidate-dob">
              Tanggal lahir
            </label>
            <input
              id="candidate-dob"
              type="date"
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.target.value)}
              className="form-input"
            />
          </div>

          <div className="auth-form-actions">
            <Button type="button" onClick={backToSignup} variant="ghost" size="sm">
              Kembali
            </Button>
            <Button type="submit" loading={isSubmitting} variant="primary" size="md">
              Selesai
            </Button>
          </div>
        </form>
      ) : null}

      {method === "credentials" && stage === "recruiterOnboarding" ? (
        <form onSubmit={onSubmitRecruiterOnboarding} className="auth-form">
          <p>
            Lengkapi data penyelenggara Anda. Setelah mendaftar, akun Anda dapat membuat draf
            kompetisi, tetapi baru bisa mempublikasikannya setelah tim kami menyetujui Anda sebagai{" "}
            <strong>Rekruter Terpercaya</strong>.
          </p>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="recruiter-full-name">
              Nama lengkap
            </label>
            <input
              id="recruiter-full-name"
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="form-input"
              placeholder="Nama lengkap sesuai identitas"
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="recruiter-mobile">
              Nomor ponsel
            </label>
            <input
              id="recruiter-mobile"
              type="tel"
              value={recruiterMobile}
              onChange={(event) => setRecruiterMobile(event.target.value)}
              className="form-input"
              placeholder="Contoh: 0812xxxxxxx"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="recruiter-corporate-email">
              Email korporat / institusi (Opsional)
            </label>
            <input
              id="recruiter-corporate-email"
              type="email"
              value={recruiterCorporateEmail}
              onChange={(event) => setRecruiterCorporateEmail(event.target.value)}
              className="form-input"
              placeholder="nama@perusahaan.co.id"
            />
            <p className="form-hint">
              Email dari domain korporat mempercepat antrean peninjauan Anda.
            </p>
          </div>

          <div className="auth-form-actions">
            <Button type="button" onClick={backToSignup} variant="ghost" size="sm">
              Kembali
            </Button>
            <Button type="submit" loading={isSubmitting} variant="primary" size="md">
              Selesai
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
};
