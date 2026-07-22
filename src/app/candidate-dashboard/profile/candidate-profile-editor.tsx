"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/primitives";
import {
  readErrorCode,
  sessionFetch,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
} from "@/lib/session/session-fetch";

const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

export type CandidateProfileFormValues = {
  fullName: string;
  phoneNumber: string;
  occupation: string;
  dateOfBirth: string;
};

type Props = {
  expectedUserId: string;
  initial: CandidateProfileFormValues;
};

export const CandidateProfileEditor = ({ expectedUserId, initial }: Props) => {
  const router = useRouter();
  const { addToast } = useToast();

  const [fullName, setFullName] = useState(initial.fullName);
  const [phoneNumber, setPhoneNumber] = useState(initial.phoneNumber);
  const [occupation, setOccupation] = useState(initial.occupation);
  const [dateOfBirth, setDateOfBirth] = useState(initial.dateOfBirth);
  const [isSaving, setIsSaving] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);

    try {
      const res = await sessionFetch(expectedUserId, "/api/v1/candidate/me/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.trim(),
          occupation,
          dateOfBirth,
        }),
      });

      if (!res.ok) {
        const code = (await readErrorCode(res)) ?? `http_${res.status}`;
        const message =
          code === SESSION_MISMATCH_CODE
            ? SESSION_MISMATCH_MESSAGE
            : "Gagal menyimpan data. Periksa kembali isian Anda.";
        addToast({ type: "error", message });
        return;
      }

      addToast({ type: "success", message: "Data kandidat berhasil disimpan." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan data karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="auth-form">
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
          type="submit"
          disabled={isSaving}
          className="ui-button"
          data-variant="primary"
          data-size="md"
        >
          {isSaving ? "Menyimpan..." : "Simpan perubahan"}
        </button>
      </div>
    </form>
  );
};
