"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";

// Step 6.5d — minimal-proof OAuth role picker. Reached after a brand-new Google user is routed to
// /auth/login?oauth=<carrier> (Step 6.5d.1 merged the role picker onto the single login page). The
// carrier is the server's HMAC-signed Google identity; this
// component never parses it, it only forwards it (plus the declared role) to the oauth-finalize
// credentials provider, which verifies the carrier, creates the account, and signs the user in.
//
// A candidate signup additionally collects the four onboarding fields, and a recruiter signup
// collects the affiliation form (full name, mobile number, optional corporate email); both
// forward their fields alongside the carrier and role, so a Google-origin account lands with its
// onboarding data already written and — for recruiters — already entered into the trust-review
// queue, exactly like the credentials-signup path. Neither role finalizes without its form.
type OAuthRolePickerProps = {
  carrier: string;
  email: string;
};

type Stage = "choose" | "candidateOnboarding" | "recruiterOnboarding";

const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

const mapFinalizeError = (error: string | null | undefined): string => {
  const normalized = error?.toUpperCase() ?? "";
  // 6.5-HARDENING.1 — single-use carrier. A replayed carrier (already redeemed) and a fail-closed
  // "cannot confirm single-use" both mean the same user action: start Google sign-in again.
  if (normalized.includes("REPLAYED") || normalized.includes("UNAVAILABLE")) {
    return "Sesi pendaftaran Google ini tidak dapat digunakan lagi. Silakan mulai lagi masuk dengan Google.";
  }
  if (normalized.includes("INVALID_CARRIER")) {
    return "Sesi Google sudah kedaluwarsa atau tidak valid. Silakan masuk dengan Google lagi.";
  }
  if (normalized.includes("CANDIDATE_PROFILE")) {
    return "Data kandidat belum lengkap atau tidak valid. Periksa kembali isian Anda.";
  }
  if (normalized.includes("RECRUITER_VERIFICATION")) {
    return "Data rekruter belum lengkap atau tidak valid. Periksa kembali isian Anda.";
  }
  if (normalized.includes("ACCOUNT_CONFLICT")) {
    return "Akun untuk email ini sudah ada. Coba masuk dengan metode yang sudah terdaftar.";
  }
  if (normalized.includes("INVALID_ROLE")) {
    return "Peran tidak valid. Pilih Kandidat atau Recruiter.";
  }
  return "Pendaftaran dengan Google gagal. Silakan coba lagi.";
};

export const OAuthRolePicker = ({ carrier, email }: OAuthRolePickerProps) => {
  const [stage, setStage] = useState<Stage>("choose");
  const [isSubmitting, setIsSubmitting] = useState<"candidate" | "recruiter" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Candidate onboarding fields — collected on the candidateOnboarding stage and forwarded with the
  // finalize request.
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [occupation, setOccupation] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // Recruiter affiliation fields — collected on the recruiterOnboarding stage and forwarded with
  // the finalize request. Separate state from the candidate fields above: a user can navigate
  // back to "choose" and pick the other role, so the two forms must not share state.
  const [recruiterFullName, setRecruiterFullName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [corporateEmail, setCorporateEmail] = useState("");

  const finalize = async (
    role: "candidate" | "recruiter",
    extraFields: Record<string, string> | null,
  ) => {
    setIsSubmitting(role);
    setErrorMessage(null);

    try {
      const result = await signIn(OAUTH_FINALIZE_PROVIDER, {
        carrier,
        role,
        ...(extraFields ?? {}),
        callbackUrl: "/",
        redirect: false,
      });

      if (result?.ok && result.url) {
        window.location.assign(result.url);
        return;
      }

      setErrorMessage(mapFinalizeError(result?.error));
    } catch {
      setErrorMessage(
        "Pendaftaran dengan Google gagal karena gangguan koneksi atau server. Coba lagi.",
      );
    } finally {
      setIsSubmitting(null);
    }
  };

  const onSubmitCandidateOnboarding = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (fullName.trim().length < 2) {
      setErrorMessage("Isi nama lengkap (minimal 2 karakter).");
      return;
    }
    if (phoneNumber.replace(/\D/g, "").length < 8) {
      setErrorMessage("Isi nomor telepon yang valid (minimal 8 digit).");
      return;
    }
    if (!occupation) {
      setErrorMessage("Pilih status Anda saat ini.");
      return;
    }
    if (!dateOfBirth) {
      setErrorMessage("Isi tanggal lahir Anda.");
      return;
    }

    void finalize("candidate", {
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      occupation,
      dateOfBirth,
    });
  };

  const onSubmitRecruiterOnboarding = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (recruiterFullName.trim().length < 2) {
      setErrorMessage("Isi nama lengkap (minimal 2 karakter).");
      return;
    }
    if (mobileNumber.replace(/\D/g, "").length < 8) {
      setErrorMessage("Isi nomor ponsel yang valid (minimal 8 digit).");
      return;
    }

    void finalize("recruiter", {
      fullName: recruiterFullName.trim(),
      mobileNumber: mobileNumber.trim(),
      corporateEmail: corporateEmail.trim(),
    });
  };

  return (
    <AuthPageFrame
      eyebrow="Pendaftaran Google"
      title="Tetapkan peran utama untuk memulai."
      description="Peran menjaga pengalaman kandidat dan penyelenggara tetap jelas sejak akses pertama."
    >
      <div className="auth-entry">
        <header className="auth-entry-header">
          <p className="eyebrow">Langkah terakhir</p>
          <h1>Selesaikan pendaftaran dengan Google</h1>
        </header>
        <p className="auth-intro-copy">
          Anda masuk sebagai <span className="auth-email-emphasis">{email}</span>. Pilih peran untuk
          menyelesaikan pembuatan akun. Akun baru hanya dibuat setelah Anda memilih peran.
        </p>

        {stage === "choose" ? (
          <div className="auth-role-list">
            <button
              type="button"
              disabled={isSubmitting !== null}
              onClick={() => {
                setErrorMessage(null);
                // Prefill the candidate's declared full name from the Google display name where
                // available; it stays editable.
                setFullName((current) => current || email);
                setStage("candidateOnboarding");
              }}
              className="auth-role-option"
            >
              <strong>Daftar sebagai Kandidat</strong>
              <span>Siapa pun yang mencari kompetisi, beasiswa, dan peluang lain.</span>
            </button>
            <button
              type="button"
              disabled={isSubmitting !== null}
              onClick={() => {
                setErrorMessage(null);
                // Prefill the recruiter's declared full name from the Google display name where
                // available; it stays editable.
                setRecruiterFullName((current) => current || email);
                setStage("recruiterOnboarding");
              }}
              className="auth-role-option"
            >
              <strong>Daftar sebagai Recruiter</strong>
              <span>Perwakilan institusi yang ingin menerbitkan dan mengelola peluang.</span>
            </button>
          </div>
        ) : null}

        {stage === "candidateOnboarding" ? (
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
              <select
                id="candidate-occupation"
                value={occupation}
                onChange={(event) => setOccupation(event.target.value)}
                className="form-input"
              >
                <option value="">Pilih status Anda</option>
                {OCCUPATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
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
              <button
                type="button"
                onClick={() => {
                  setErrorMessage(null);
                  setStage("choose");
                }}
                className="ui-button"
                data-variant="ghost"
                data-size="sm"
              >
                Kembali
              </button>
              <button
                type="submit"
                disabled={isSubmitting !== null}
                className="ui-button"
                data-variant="primary"
                data-size="md"
              >
                {isSubmitting === "candidate" ? "Membuat akun..." : "Selesaikan pendaftaran"}
              </button>
            </div>
          </form>
        ) : null}

        {stage === "recruiterOnboarding" ? (
          <form onSubmit={onSubmitRecruiterOnboarding} className="auth-form">
            <p>
              Lengkapi data penyelenggara Anda. Akun akan menunggu peninjauan sebelum dapat
              menerbitkan kompetisi.
            </p>

            <div className="form-field">
              <label className="form-label form-label-required" htmlFor="recruiter-full-name">
                Nama lengkap
              </label>
              <input
                id="recruiter-full-name"
                type="text"
                value={recruiterFullName}
                onChange={(event) => setRecruiterFullName(event.target.value)}
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
                value={mobileNumber}
                onChange={(event) => setMobileNumber(event.target.value)}
                className="form-input"
                placeholder="Contoh: 0812xxxxxxx"
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="recruiter-corporate-email">
                Email korporat / institusi (opsional)
              </label>
              <input
                id="recruiter-corporate-email"
                type="email"
                value={corporateEmail}
                onChange={(event) => setCorporateEmail(event.target.value)}
                className="form-input"
                placeholder="nama@perusahaan.co.id"
              />
              <p className="form-hint">
                Email domain korporat mempercepat antrean peninjauan Anda.
              </p>
            </div>

            <div className="auth-form-actions">
              <button
                type="button"
                onClick={() => {
                  setErrorMessage(null);
                  setStage("choose");
                }}
                className="ui-button"
                data-variant="ghost"
                data-size="sm"
              >
                Kembali
              </button>
              <button
                type="submit"
                disabled={isSubmitting !== null}
                className="ui-button"
                data-variant="primary"
                data-size="md"
              >
                {isSubmitting === "recruiter" ? "Membuat akun..." : "Selesaikan pendaftaran"}
              </button>
            </div>
          </form>
        ) : null}

        {errorMessage ? (
          <p className="feedback" data-tone="error">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </AuthPageFrame>
  );
};

// The oauth-finalize provider id must match OAUTH_FINALIZE_PROVIDER_ID in oauth-account.ts. Kept as
// a local literal because this is a client component and may not import server-only modules.
const OAUTH_FINALIZE_PROVIDER = "oauth-finalize";
