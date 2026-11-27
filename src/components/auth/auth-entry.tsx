"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import {
  Button,
  ButtonLink,
  Feedback,
  FormInput,
  FormLabel,
  Icon,
  IconButton,
  PasswordField,
  SelectField,
  StepIndicator,
  usePageTransition,
} from "@/components/ui";
import { AssentNotice } from "@/components/legal/assent-notice";
import { useToast } from "@/components/ui/primitives";
import { rememberGoogleReturnPath } from "@/components/auth/google-return-path";
import {
  errorMessageFor,
  ONBOARDING_FIELD_REFUSAL_COPY,
  refusalCopyKey,
} from "@/lib/errors/error-copy";

// Method-first single-page auth entry. Replaces the earlier two-page login/register
// toggle. The user first picks a sign-in method; then:
//   - Google: full redirect; the signIn callback decides everything server-side (existing →
//     signed in; new → /auth/login?oauth=<carrier> details form; new with an address Google has
//     not verified → email-and-code notice; suspended → /suspended; unverified same-email → deny
//     notice). The page this tab started from is kept for the details form (google-return-path.ts).
//   - Email & password: the user enters email + password. We classify the email server-side
//     (/api/v1/auth/identify) and branch:
//       • verified  → attempt the password sign-in (path a). Wrong/absent password → generic
//                     "email atau password salah" (a Google-only account lands here too).
//       • unverified→ show the verify notice. The person completes the sign-up form, or keeps
//                     the one register just refused, and gets a code through the resend
//                     endpoint; the details sent with the code replace an earlier sign-up's.
//                     Register is never called here (it refuses an existing address).
//       • none      → details form; create the account via the existing register endpoint,
//                     which sends a verification code (path b). Account usable once the code is
//                     typed.
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
  // True when arriving from a completed password reset or change (?passwordChanged=1). Opens the
  // credentials method directly with a confirmation message.
  passwordChangedNotice?: boolean;
  // Server-resolved message for a `?error=` query param (e.g. a failed sign-in redirect, or the
  // safe-link deny notice). Fired as a toast once on mount.
  initialErrorMessage?: string;
};

type Method = "choose" | "credentials";
type CredentialStage = "entry" | "verifyNotice" | "verifyCode" | "signup" | "candidateOnboarding";

// Candidate onboarding option list. Values must match the `candidate_occupation` DB enum exactly.
const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

const SIGNUP_ERROR_COPY: Partial<Record<string, string>> = {
  ...ONBOARDING_FIELD_REFUSAL_COPY,
  rate_limited: "Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.",
  invalid_name: "Isi nama lengkap (minimal 2 karakter) untuk mendaftar.",
  invalid_email: "Format email tidak valid. Gunakan format seperti nama@kampus.ac.id.",
  invalid_password: "Password harus 8 sampai 72 karakter.",
  candidate_profile_invalid_value: "Periksa data kandidat Anda lalu coba lagi.",
  email_exists: "Akun untuk email ini sudah ada. Silakan masuk, bukan mendaftar.",
  verification_email_failed:
    "Akun sudah dibuat, tetapi kode verifikasi belum terkirim. Tekan Selesai sekali lagi, lalu kirim kode verifikasi.",
  username_generation_failed: "Akun belum dapat dibuat saat ini. Coba lagi beberapa saat.",
};

const SIGNUP_FALLBACK = "Pendaftaran gagal. Coba lagi beberapa saat.";

const verificationFailureMessage = (status: number, errorCode: string | undefined): string => {
  if (errorCode === "verification_code_invalid") {
    return "Kode salah atau sudah tidak berlaku. Periksa kode di email Anda, atau kirim ulang kode.";
  }
  if (errorCode === "verification_code_daily_limit") {
    return "Terlalu banyak percobaan kode yang salah untuk email ini. Coba lagi dalam 24 jam.";
  }
  if (errorCode === "verification_code_attempts_exceeded") {
    return "Terlalu banyak percobaan kode yang salah. Kirim ulang kode, atau coba lagi nanti.";
  }
  if (status === 429) {
    return "Terlalu banyak permintaan dari jaringan ini. Tunggu beberapa menit lalu coba lagi.";
  }
  if (errorCode === "email_exists") {
    return "Email ini sudah terverifikasi. Silakan masuk dengan password Anda.";
  }
  if (errorCode === "invalid_password") {
    return "Password harus 8 sampai 72 karakter. Kembali, lalu masukkan password yang memenuhi syarat.";
  }
  if (status === 503) {
    return "Verifikasi sedang tidak tersedia. Coba lagi beberapa saat.";
  }
  return "Verifikasi gagal. Coba lagi beberapa saat.";
};

// The server first checks the details at the code stage on the unverified path, so a refusal
// must send the person back to the form.
const SIGNUP_DETAILS_ERROR_CODES = new Set([
  "invalid_name",
  "candidate_profile_invalid_payload",
  "candidate_profile_invalid_fields",
  "candidate_profile_invalid_value",
]);

export const AuthEntry = ({
  googleEnabled,
  verificationEnabled,
  callbackUrl,
  initialEmail,
  verifiedNotice,
  passwordChangedNotice,
  initialErrorMessage,
}: AuthEntryProps) => {
  const [method, setMethod] = useState<Method>(
    verifiedNotice || passwordChangedNotice ? "credentials" : "choose",
  );
  const [stage, setStage] = useState<CredentialStage>("entry");

  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // The participant details, sent with the account creation request. fullName is also sent as the
  // account name.
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [occupation, setOccupation] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [signupDetails, setSignupDetails] = useState<Record<string, unknown> | null>(null);
  const [completingUnverified, setCompletingUnverified] = useState(false);
  const stagePanelRef = useRef<HTMLDivElement>(null);
  const verificationCodeInputRef = useRef<HTMLInputElement>(null);
  const { begin: beginPageTransition } = usePageTransition();
  const { addToast } = useToast();

  useEffect(() => {
    if (verifiedNotice) {
      addToast({
        type: "success",
        message: "Email berhasil diverifikasi. Silakan masuk dengan password Anda.",
      });
    }
    if (passwordChangedNotice) {
      addToast({
        type: "success",
        message: "Password berhasil diubah. Silakan masuk dengan password baru.",
      });
    }
    if (initialErrorMessage) {
      addToast({ type: "error", message: initialErrorMessage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The form that held focus unmounts at these stages, so focus moves to what replaced it: the
  // verify notice's message, or the code box.
  useEffect(() => {
    if (stage === "verifyNotice") {
      stagePanelRef.current?.focus();
    }
    if (stage === "verifyCode") {
      verificationCodeInputRef.current?.focus();
    }
  }, [stage]);

  const startGoogle = () => {
    rememberGoogleReturnPath(callbackUrl);
    // Hands off to Google's consent screen. That is a full document navigation, so the blocking
    // screen stays up until the browser leaves this page.
    beginPageTransition("Menghubungkan ke Google…");
    void signIn("google", { callbackUrl: callbackUrl ?? "/" });
  };

  const finishLogin = (url: string) => {
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
    // public /suspended page.
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

    clearSignupForm();
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

      // state === "none": no account for this email, so the sign-up asks for the details.
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

      if (response.status === 429) {
        addToast({
          type: "error",
          message: "Terlalu banyak permintaan kode. Tunggu beberapa menit lalu coba lagi.",
        });
        return;
      }

      if (!response.ok) {
        addToast({
          type: "error",
          message: "Gagal mengirim kode verifikasi. Coba lagi beberapa saat.",
        });
        return;
      }

      setVerificationCode("");
      setStage("verifyCode");
      addToast({
        type: "success",
        message: "Kode verifikasi telah dikirim. Buka inbox/spam Anda.",
      });
    } catch {
      addToast({
        type: "error",
        message: "Gagal mengirim kode verifikasi karena gangguan koneksi.",
      });
    } finally {
      setIsResending(false);
    }
  };

  // The code verification sets this password, so a password the server would refuse must not spend a code.
  const sendCodeForUnverifiedAddress = (details: Record<string, unknown>) => {
    if (password.trim().length < 8 || password.trim().length > 72) {
      addToast({
        type: "error",
        message:
          "Password harus 8 sampai 72 karakter. Kembali, lalu masukkan password yang memenuhi syarat.",
      });
      return;
    }
    setSignupDetails(details);
    void onResend();
  };

  // Creates the account with the participant details. The register route sends the verification
  // code.
  const registerAccount = async (details: Record<string, unknown>) => {
    setSignupDetails(details);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: fullName.trim(),
          email: email.trim().toLowerCase(),
          password,
          ...details,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; details?: { fields?: string[] } };
        } | null;
        const code = payload?.error?.code;
        const firstField = payload?.error?.details?.fields?.[0];

        if (code === "email_not_verified") {
          setStage("verifyNotice");
          return;
        }

        addToast({
          type: "error",
          message: errorMessageFor(
            refusalCopyKey(code, firstField, SIGNUP_ERROR_COPY),
            SIGNUP_ERROR_COPY,
            SIGNUP_FALLBACK,
          ),
        });
        return;
      }

      setVerificationCode("");
      setStage("verifyCode");
    } catch {
      addToast({
        type: "error",
        message: "Pendaftaran gagal karena gangguan koneksi. Coba lagi beberapa saat.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Plain fetch rather than sessionFetch: no session exists before the address is verified.
  const onSubmitVerificationCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signupDetails) {
      setStage("verifyNotice");
      return;
    }
    setIsVerifying(true);

    try {
      const response = await fetch("/api/v1/auth/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          code: verificationCode.trim(),
          password,
          name: fullName.trim(),
          ...signupDetails,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        const errorCode = payload?.error?.code;
        if (errorCode && SIGNUP_DETAILS_ERROR_CODES.has(errorCode)) {
          addToast({
            type: "error",
            message:
              "Data pendaftaran belum sesuai. Periksa kembali isian Anda, lalu lanjutkan lagi.",
          });
          setStage("candidateOnboarding");
          return;
        }
        addToast({
          type: "error",
          message: verificationFailureMessage(response.status, errorCode),
        });
        if (errorCode === "email_exists") {
          clearSignupForm();
          setStage("entry");
        }
        return;
      }

      // The address is verified at this point, so a failed sign-in must not read as a failed
      // verification.
      try {
        await attemptCredentialSignIn();
      } catch {
        addToast({
          type: "success",
          message: "Email berhasil diverifikasi. Silakan masuk dengan password Anda.",
        });
        clearSignupForm();
        setStage("entry");
      }
    } catch {
      addToast({
        type: "error",
        message: "Verifikasi gagal karena gangguan koneksi. Coba lagi beberapa saat.",
      });
    } finally {
      setIsVerifying(false);
    }
  };

  // Checks the password confirmation, then opens the participant details form.
  const onSubmitSignupPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!verificationEnabled) {
      addToast({
        type: "error",
        message: "Pendaftaran email sedang tidak tersedia. Coba lagi nanti.",
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
    setStage("candidateOnboarding");
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

    const body = {
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      occupation,
      dateOfBirth,
    };

    if (completingUnverified) {
      sendCodeForUnverifiedAddress(body);
      return;
    }
    void registerAccount(body);
  };

  // A return to the email step may hand the tab to another person, so no sign-up detail stays.
  const clearSignupForm = () => {
    setSignupDetails(null);
    setCompletingUnverified(false);
    setConfirmPassword("");
    setFullName("");
    setPhoneNumber("");
    setOccupation("");
    setDateOfBirth("");
    setVerificationCode("");
  };

  const backToChoose = () => {
    clearSignupForm();
    setPassword("");
    setMethod("choose");
    setStage("entry");
  };

  const backToEntry = () => {
    clearSignupForm();
    setPassword("");
    setStage("entry");
  };

  const backToSignup = () => {
    setStage("signup");
  };

  return (
    <div className="auth-entry" data-has-back={method === "credentials" && stage === "entry"}>
      {method === "credentials" && stage === "entry" ? (
        <IconButton
          icon="arrow-left"
          variant="plain"
          size="back"
          label="Ganti metode"
          className="auth-entry-back"
          onClick={backToChoose}
        />
      ) : null}
      <header className="auth-entry-header">
        <h1>Masuk atau daftar</h1>
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
              <Icon name="chevron-down" className="auth-method-button-chevron" />
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
            <Icon name="chevron-down" className="auth-method-button-chevron" />
          </button>
        </div>
      ) : null}

      {method === "credentials" && stage === "entry" ? (
        <form onSubmit={onSubmitEntry} className="auth-form">
          <div className="form-field">
            <FormLabel htmlFor="auth-email" required>
              Email
            </FormLabel>
            <FormInput
              id="auth-email"
              name="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="nama@kampus.ac.id"
            />
          </div>

          <div className="form-field">
            <div className="auth-label-row">
              <FormLabel htmlFor="auth-password" required>
                Password
              </FormLabel>
              <ButtonLink
                variant="link"
                size="sm"
                href={`/auth/forgot-password?email=${encodeURIComponent(email.trim().toLowerCase())}`}
              >
                Lupa password?
              </ButtonLink>
            </div>
            <PasswordField
              id="auth-password"
              name="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Masukkan password"
              aria-describedby="auth-password-help"
            />
            <p id="auth-password-help" className="form-help">
              Password minimal 8 karakter.
            </p>
          </div>

          <div className="auth-form-actions">
            <Button type="submit" loading={isSubmitting} variant="primary" size="lg" fullWidth>
              Lanjut
              <Icon name="arrow-right" size="md" />
            </Button>
          </div>
          <p className="form-help">
            Belum punya akun? Masukkan email &amp; password, lalu lengkapi data Anda di langkah
            berikutnya.
          </p>
        </form>
      ) : null}

      {method === "credentials" && stage === "verifyNotice" && signupDetails ? (
        <div className="auth-stage-panel" ref={stagePanelRef} tabIndex={-1} role="status">
          <p>
            Email <span className="font-medium">{email}</span> belum diverifikasi. Kirim kode
            verifikasi ke email ini, lalu masukkan kodenya di langkah berikutnya.
          </p>
          <div className="auth-form-actions">
            <Button type="button" onClick={backToEntry} variant="outline" size="sm">
              Kembali
            </Button>
            <Button
              type="button"
              loading={isResending}
              disabled={!verificationEnabled}
              onClick={() => {
                sendCodeForUnverifiedAddress(signupDetails);
              }}
              variant="primary"
              size="sm"
            >
              Kirim kode verifikasi
            </Button>
          </div>
        </div>
      ) : null}

      {method === "credentials" && stage === "verifyNotice" && !signupDetails ? (
        <div className="auth-stage-panel" ref={stagePanelRef} tabIndex={-1} role="status">
          <p>
            Email <span className="font-medium">{email}</span> belum diverifikasi. Lengkapi data
            pendaftaran Anda, lalu kami kirim kode verifikasi ke email ini.
          </p>
          <div className="auth-form-actions">
            <Button type="button" onClick={backToEntry} variant="outline" size="sm">
              Kembali
            </Button>
            <Button
              type="button"
              disabled={!verificationEnabled}
              onClick={() => {
                setCompletingUnverified(true);
                setStage("signup");
              }}
              variant="primary"
              size="sm"
            >
              Lengkapi pendaftaran
            </Button>
          </div>
        </div>
      ) : null}

      {method === "credentials" && stage === "verifyCode" ? (
        <form onSubmit={onSubmitVerificationCode} className="auth-form">
          <p id="auth-verification-code-status" role="status">
            Kami sudah mengirim kode 6 digit ke <span className="font-medium">{email}</span>.
            Masukkan kode tersebut untuk mengaktifkan akun Anda. Kode berlaku 10 menit.
          </p>

          <div className="form-field">
            <FormLabel htmlFor="auth-verification-code" required>
              Kode verifikasi
            </FormLabel>
            <FormInput
              ref={verificationCodeInputRef}
              id="auth-verification-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ""))}
              aria-describedby="auth-verification-code-status"
            />
          </div>

          <div className="auth-form-actions">
            <Button type="button" onClick={backToEntry} variant="outline" size="sm">
              Kembali
            </Button>
            <Button
              type="button"
              loading={isResending}
              disabled={isVerifying}
              onClick={() => {
                void onResend();
              }}
              variant="outline"
              size="sm"
            >
              Kirim ulang kode
            </Button>
            <Button
              type="submit"
              loading={isVerifying}
              disabled={isResending}
              variant="primary"
              size="md"
            >
              Verifikasi
            </Button>
          </div>
        </form>
      ) : null}

      {method === "credentials" && stage === "signup" ? (
        <form onSubmit={onSubmitSignupPassword} className="auth-form">
          <StepIndicator currentStep={2} totalSteps={3} stepName="Konfirmasi" />
          {!verificationEnabled ? (
            <Feedback tone="warning">
              Pendaftaran email sedang tidak tersedia. Coba lagi nanti.
            </Feedback>
          ) : null}
          {completingUnverified ? (
            <p>
              Email <span className="font-medium">{email}</span> belum diverifikasi. Ulangi password
              Anda. Setelah data Anda lengkap, kami kirim kode verifikasi ke email ini.
            </p>
          ) : (
            <p>
              Belum ada akun untuk <span className="font-medium">{email}</span>. Ulangi password
              Anda untuk mendaftar.
            </p>
          )}

          <div className="form-field">
            <FormLabel htmlFor="auth-confirm-password" required>
              Konfirmasi password
            </FormLabel>
            <PasswordField
              id="auth-confirm-password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Ulangi password Anda"
            />
          </div>

          <AssentNotice />

          <div className="auth-form-actions">
            <Button type="button" onClick={backToEntry} variant="outline" size="sm">
              Kembali
            </Button>
            <Button type="submit" variant="primary" size="md">
              Lanjut
            </Button>
          </div>
        </form>
      ) : null}

      {method === "credentials" && stage === "candidateOnboarding" ? (
        <form onSubmit={onSubmitCandidateOnboarding} className="auth-form">
          <StepIndicator currentStep={3} totalSteps={3} stepName="Profil" />
          <p>Lengkapi data kandidat Anda. Data ini bisa diubah nanti di dasbor Anda.</p>

          <div className="form-field">
            <FormLabel htmlFor="candidate-full-name" required>
              Nama lengkap
            </FormLabel>
            <FormInput
              id="candidate-full-name"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Nama lengkap sesuai identitas"
              aria-describedby="candidate-full-name-help"
            />
            <p className="form-help" id="candidate-full-name-help">
              Nama ini juga tampil di profil publik Anda dan dapat diubah di halaman profil.
            </p>
          </div>

          <div className="form-field">
            <FormLabel htmlFor="candidate-phone" required>
              Nomor telepon
            </FormLabel>
            <FormInput
              id="candidate-phone"
              type="tel"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder="Contoh: 0812xxxxxxx"
            />
          </div>

          <div className="form-field">
            <FormLabel htmlFor="candidate-occupation" required>
              Status saat ini
            </FormLabel>
            <SelectField
              id="candidate-occupation"
              label="Status saat ini"
              required
              value={occupation}
              placeholder="Pilih status Anda"
              options={[...OCCUPATION_OPTIONS]}
              onChange={setOccupation}
            />
          </div>

          <div className="form-field">
            <FormLabel htmlFor="candidate-dob" required>
              Tanggal lahir
            </FormLabel>
            <FormInput
              id="candidate-dob"
              type="date"
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.target.value)}
            />
          </div>

          <div className="auth-form-actions">
            <Button type="button" onClick={backToSignup} variant="outline" size="sm">
              Kembali
            </Button>
            <Button type="submit" loading={isSubmitting || isResending} variant="primary" size="md">
              Selesai
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
};
