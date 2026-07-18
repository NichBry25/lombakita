"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";

// Step 6.5d — minimal-proof OAuth role picker. Reached after a brand-new Google user is routed to
// /auth/login?oauth=<carrier> (Step 6.5d.1 merged the role picker onto the single login page). The
// carrier is the server's HMAC-signed Google identity; this
// component never parses it, it only forwards it (plus the declared role) to the oauth-finalize
// credentials provider, which verifies the carrier, creates the account, and signs the user in.
type OAuthRolePickerProps = {
  carrier: string;
  email: string;
};

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
  if (normalized.includes("ACCOUNT_CONFLICT")) {
    return "Akun untuk email ini sudah ada. Coba masuk dengan metode yang sudah terdaftar.";
  }
  if (normalized.includes("INVALID_ROLE")) {
    return "Peran tidak valid. Pilih Kandidat atau Recruiter.";
  }
  return "Pendaftaran dengan Google gagal. Silakan coba lagi.";
};

export const OAuthRolePicker = ({ carrier, email }: OAuthRolePickerProps) => {
  const [isSubmitting, setIsSubmitting] = useState<"candidate" | "recruiter" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const finalize = async (role: "candidate" | "recruiter") => {
    setIsSubmitting(role);
    setErrorMessage(null);

    try {
      const result = await signIn(OAUTH_FINALIZE_PROVIDER, {
        carrier,
        role,
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

        <div className="auth-role-list">
          <button
            type="button"
            disabled={isSubmitting !== null}
            onClick={() => {
              void finalize("candidate");
            }}
            className="auth-role-option"
          >
            <strong>
              {isSubmitting === "candidate" ? "Membuat akun..." : "Daftar sebagai Kandidat"}
            </strong>
            <span>Mahasiswa atau lulusan yang mencari kompetisi, beasiswa, dan peluang lain.</span>
          </button>
          <button
            type="button"
            disabled={isSubmitting !== null}
            onClick={() => {
              void finalize("recruiter");
            }}
            className="auth-role-option"
          >
            <strong>
              {isSubmitting === "recruiter" ? "Membuat akun..." : "Daftar sebagai Recruiter"}
            </strong>
            <span>Perwakilan institusi yang ingin menerbitkan dan mengelola peluang.</span>
          </button>
        </div>

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
