"use client";

import { FormEvent, useState } from "react";
import { useSession } from "next-auth/react";
import { Button, SelectField } from "@/components/ui";
import type { VerifiableRole } from "@/server/auth/role-verification";
import { useToast } from "@/components/ui/primitives";

type VerifyRoleFormProps = {
  role: VerifiableRole;
};

// Candidate onboarding option list. Values must match the `candidate_occupation` DB enum exactly.
const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

// Verification mechanics are deferred. This component calls the completion API and refreshes
// the session JWT so the new verifiedRoles entry is reflected without a manual re-login.
//
// Verifying the candidate role also collects the four onboarding fields — mirroring the
// registration onboarding form — and sends them in the same request, so a recruiter-first account
// gaining candidate access lands with an onboarding profile written (parity with the credentials-
// and OAuth-signup candidacy paths). The recruiter path submits with no extra fields.
export function VerifyRoleForm({ role }: VerifyRoleFormProps) {
  const { update } = useSession();
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);

  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [occupation, setOccupation] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // Recruiter affiliation form fields (mobile + optional corporate email).
  const [mobileNumber, setMobileNumber] = useState("");
  const [corporateEmail, setCorporateEmail] = useState("");

  const submit = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/auth/verify-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Verifikasi gagal. Coba lagi beberapa saat.",
        });
        setBusy(false);
        return;
      }

      const payload = (await response.json()) as { redirectTo: string };

      // Refresh the JWT so the next page render sees the updated verifiedRoles. We MUST await
      // this before navigating — otherwise the destination dashboard's server-side check would
      // read a stale session.
      await update();

      window.location.assign(payload.redirectTo);
    } catch {
      addToast({
        type: "error",
        message: "Verifikasi gagal karena gangguan koneksi. Periksa jaringan Anda lalu coba lagi.",
      });
      setBusy(false);
    }
  };

  if (role === "recruiter") {
    const onSubmitRecruiter = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy) return;

      if (fullName.trim().length < 2) {
        addToast({ type: "error", message: "Isi nama lengkap (minimal 2 karakter)." });
        return;
      }
      if (mobileNumber.replace(/\D/g, "").length < 8) {
        addToast({ type: "error", message: "Isi nomor ponsel yang valid (minimal 8 digit)." });
        return;
      }

      void submit({
        role,
        fullName: fullName.trim(),
        mobileNumber: mobileNumber.trim(),
        corporateEmail: corporateEmail.trim() || null,
      });
    };

    return (
      <form onSubmit={onSubmitRecruiter} className="auth-form">
        <p>
          Lengkapi data penyelenggara Anda. Setelah dikirim, akun akan menunggu peninjauan tim kami
          untuk menjadi <strong>Rekruter Terpercaya</strong>. Anda bisa membuat draf kompetisi
          sekarang, tetapi belum bisa mempublikasikannya sampai disetujui.
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
            Email dari domain korporat mempercepat antrean peninjauan Anda.
          </p>
        </div>

        <Button type="submit" loading={busy} data-testid="verify-role-recruiter">
          Selesai
        </Button>
      </form>
    );
  }

  const onSubmitCandidate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

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

    void submit({
      role,
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      occupation,
      dateOfBirth,
    });
  };

  return (
    <form onSubmit={onSubmitCandidate} className="auth-form">
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

      <Button type="submit" loading={busy} data-testid="verify-role-candidate">
        Selesai
      </Button>
    </form>
  );
}
