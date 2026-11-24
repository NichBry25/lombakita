"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import { Button, FormInput, FormLabel, SelectField, usePageTransition } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { AssentNotice } from "@/components/legal/assent-notice";
import { readGoogleReturnPath } from "@/components/auth/google-return-path";
import { GOOGLE_EMAIL_UNVERIFIED_MESSAGE } from "@/lib/errors/error-copy";

// The details form of a brand-new Google user, rendered on /auth/login?oauth=<carrier>. The carrier
// is the server's HMAC-signed Google identity. This component never parses it: it forwards it with
// the four participant details to the oauth-finalize credentials provider, which verifies the
// carrier, creates the account and signs the person in.
type OAuthRolePickerProps = {
  carrier: string;
  email: string;
  name: string | null;
};

const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

const mapFinalizeError = (error: string | null | undefined): string => {
  const normalized = error?.toUpperCase() ?? "";
  if (normalized.includes("EMAIL_UNVERIFIED")) {
    return GOOGLE_EMAIL_UNVERIFIED_MESSAGE;
  }
  // Single-use carrier. A replayed carrier (already redeemed) and a fail-closed
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
  if (normalized.includes("ACCOUNT_CONFLICT")) {
    return "Akun untuk email ini sudah ada. Coba masuk dengan metode yang sudah terdaftar.";
  }
  return "Pendaftaran dengan Google gagal. Silakan coba lagi.";
};

export const OAuthRolePicker = ({ carrier, email, name }: OAuthRolePickerProps) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { begin: beginPageTransition } = usePageTransition();
  const { addToast } = useToast();

  // The Google display name when the provider sent one, empty otherwise. Never the email, because
  // the field asks for a name. It stays editable.
  const [fullName, setFullName] = useState(() => name?.trim() || "");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [occupation, setOccupation] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  const finalize = async (details: Record<string, string>) => {
    setIsSubmitting(true);

    try {
      const result = await signIn(OAUTH_FINALIZE_PROVIDER, {
        carrier,
        ...details,
        callbackUrl: readGoogleReturnPath(),
        redirect: false,
      });

      if (result?.ok && result.url) {
        // A full document navigation into the signed-in app; hold the blocking screen until the
        // browser leaves rather than dropping the user back onto a finished-looking form.
        beginPageTransition("Menyiapkan akun Anda…");
        window.location.assign(result.url);
        return;
      }

      addToast({ type: "error", message: mapFinalizeError(result?.error) });
    } catch {
      addToast({
        type: "error",
        message: "Pendaftaran dengan Google gagal karena gangguan koneksi atau server. Coba lagi.",
      });
    } finally {
      setIsSubmitting(false);
    }
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

    void finalize({
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      occupation,
      dateOfBirth,
    });
  };

  return (
    <AuthPageFrame
      title="Lengkapi data untuk memulai"
      description="Satu akun untuk ikut kompetisi. Anda bisa mulai menyelenggarakan kompetisi kapan saja dari akun yang sama."
    >
      <div className="auth-entry">
        <header className="auth-entry-header">
          <h1>Selesaikan pendaftaran dengan Google</h1>
        </header>
        <p className="auth-intro-copy">
          Anda masuk sebagai <span className="auth-email-emphasis">{email}</span>. Akun baru dibuat
          setelah data Anda lengkap.
        </p>

        <form onSubmit={onSubmitCandidateOnboarding} className="auth-form">
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
            />
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

          <AssentNotice />

          <div className="auth-form-actions">
            <Button type="submit" loading={isSubmitting} variant="primary" size="md">
              Selesai
            </Button>
          </div>
        </form>
      </div>
    </AuthPageFrame>
  );
};

// The oauth-finalize provider id must match OAUTH_FINALIZE_PROVIDER_ID in oauth-account.ts. Kept as
// a local literal because this is a client component and may not import server-only modules.
const OAUTH_FINALIZE_PROVIDER = "oauth-finalize";
