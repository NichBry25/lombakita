"use client";

import { useCallback, useEffect, useState } from "react";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { PageHeader, Skeleton } from "@/components/ui";

type EnrollmentStatus = "enrolled" | "on_leave" | "graduated" | "unknown";
type EducationLevel = "D3" | "D4" | "S1" | "S2" | "S3";
type EligibilityStatus = "eligible" | "ineligible_age" | "ineligible_enrollment" | "incomplete";

type EligibilityResponse = {
  profile: {
    userId: string;
    dateOfBirth: string | null;
    enrollmentStatus: EnrollmentStatus | null;
    educationLevel: EducationLevel | null;
    universityName: string | null;
    studentIdNumber: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  eligibility: {
    status: EligibilityStatus;
    reasons: string[];
    checkedAt: string;
  };
};

type FormState = {
  dateOfBirth: string;
  enrollmentStatus: EnrollmentStatus | "";
  educationLevel: EducationLevel | "";
  universityName: string;
  studentIdNumber: string;
};

const EMPTY_FORM: FormState = {
  dateOfBirth: "",
  enrollmentStatus: "",
  educationLevel: "",
  universityName: "",
  studentIdNumber: "",
};

const STATUS_LABEL: Record<EligibilityStatus, string> = {
  eligible: "Memenuhi syarat",
  ineligible_age: "Tidak memenuhi syarat — usia",
  ineligible_enrollment: "Tidak memenuhi syarat — status studi",
  incomplete: "Belum lengkap",
};

const REASON_LABEL: Record<string, string> = {
  missing_date_of_birth: "Tanggal lahir belum diisi",
  missing_enrollment_status: "Status studi belum diisi",
  missing_education_level: "Jenjang studi belum diisi",
  missing_university_name: "Nama universitas belum diisi",
  missing_student_id_number: "Nomor mahasiswa belum diisi",
  age_below_minimum: "Usia di bawah 18 tahun",
  age_above_maximum: "Usia di atas 32 tahun",
  enrollment_status_on_leave: "Sedang cuti studi",
  enrollment_status_graduated: "Telah lulus",
  enrollment_status_unknown: "Status studi belum diketahui",
};

const formatReason = (code: string): string => REASON_LABEL[code] ?? code;

const ENROLLMENT_OPTIONS: { value: EnrollmentStatus; label: string }[] = [
  { value: "enrolled", label: "Aktif kuliah" },
  { value: "on_leave", label: "Cuti studi" },
  { value: "graduated", label: "Sudah lulus" },
  { value: "unknown", label: "Tidak diketahui" },
];

const EDUCATION_OPTIONS: { value: EducationLevel; label: string }[] = [
  { value: "D3", label: "D3 — Diploma 3" },
  { value: "D4", label: "D4 — Diploma 4" },
  { value: "S1", label: "S1 — Sarjana" },
  { value: "S2", label: "S2 — Magister" },
  { value: "S3", label: "S3 — Doktor" },
];

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan kelayakan gagal diproses.";
  } catch {
    return "Permintaan kelayakan gagal diproses.";
  }
};

type Feedback = { type: "success" | "error"; message: string } | null;

type ShellProps = { expectedUserId: string };

export const StudentEligibilityShell = ({ expectedUserId }: ShellProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [eligibility, setEligibility] = useState<EligibilityResponse["eligibility"] | null>(null);

  const applyResponse = useCallback((data: EligibilityResponse) => {
    setForm({
      dateOfBirth: data.profile.dateOfBirth ?? "",
      enrollmentStatus: (data.profile.enrollmentStatus ?? "") as EnrollmentStatus | "",
      educationLevel: (data.profile.educationLevel ?? "") as EducationLevel | "",
      universityName: data.profile.universityName ?? "",
      studentIdNumber: data.profile.studentIdNumber ?? "",
    });
    setEligibility(data.eligibility);
  }, []);

  const loadEligibility = useCallback(async () => {
    setIsLoading(true);
    setFeedback(null);

    const response = await fetch("/api/v1/students/me/eligibility", {
      cache: "no-store",
      credentials: "include",
    });

    if (!response.ok) {
      setFeedback({ type: "error", message: await extractErrorMessage(response) });
      setIsLoading(false);
      return;
    }

    const data = (await response.json()) as EligibilityResponse;
    applyResponse(data);
    setIsLoading(false);
  }, [applyResponse]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadEligibility();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadEligibility]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setFeedback(null);

    const body: Record<string, string | null> = {
      dateOfBirth: form.dateOfBirth.trim() === "" ? null : form.dateOfBirth.trim(),
      enrollmentStatus: form.enrollmentStatus === "" ? null : form.enrollmentStatus,
      educationLevel: form.educationLevel === "" ? null : form.educationLevel,
      universityName: form.universityName.trim() === "" ? null : form.universityName.trim(),
      studentIdNumber: form.studentIdNumber.trim() === "" ? null : form.studentIdNumber.trim(),
    };

    const response = await sessionFetch(expectedUserId, "/api/v1/students/me/eligibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const code = await readErrorCode(response);
      if (code === SESSION_MISMATCH_CODE) {
        setFeedback({ type: "error", message: SESSION_MISMATCH_MESSAGE });
      } else {
        setFeedback({ type: "error", message: await extractErrorMessage(response) });
      }
      setIsSaving(false);
      return;
    }

    const data = (await response.json()) as EligibilityResponse;
    applyResponse(data);
    setFeedback({ type: "success", message: "Data kelayakan berhasil diperbarui." });
    setIsSaving(false);
  };

  return (
    <main className="page-shell app-page eligibility-page">
      <PageHeader
        eyebrow="Identitas kandidat"
        title="Kelayakan mahasiswa"
        description="Lengkapi data berikut untuk mengikuti pendaftaran kompetisi. Semua data dievaluasi di server saat dibutuhkan."
        backHref="/candidate-dashboard"
        backLabel="Dasbor kandidat"
      />

      {feedback ? (
        <div
          role="status"
          className="feedback"
          data-tone={feedback.type === "success" ? "success" : "error"}
        >
          {feedback.message}
        </div>
      ) : null}

      {eligibility ? (
        <section className="eligibility-status-card" data-status={eligibility.status}>
          <p className="eyebrow">Status saat ini</p>
          <p className="eligibility-status-label" data-testid="eligibility-status">
            {STATUS_LABEL[eligibility.status]}
          </p>
          {eligibility.reasons.length > 0 ? (
            <ul className="eligibility-reasons" data-testid="eligibility-reasons">
              {eligibility.reasons.map((reason) => (
                <li key={reason}>{formatReason(reason)}</li>
              ))}
            </ul>
          ) : null}
          <p className="eligibility-checked data-text">
            Diperiksa: {new Date(eligibility.checkedAt).toLocaleString("id-ID")}
          </p>
        </section>
      ) : null}

      {isLoading ? (
        <div className="content-section stack-md" aria-label="Memuat data kelayakan">
          <Skeleton variant="title" />
          <Skeleton />
          <Skeleton />
          <Skeleton variant="media" />
        </div>
      ) : (
        <form onSubmit={onSubmit} className="content-section eligibility-form">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Data evaluasi</p>
              <h2>Profil kelayakan</h2>
            </div>
          </div>
          <div className="form-grid">
            <label className="form-field">
              <span className="form-label">Tanggal lahir</span>
              <input
                className="form-input"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => updateField("dateOfBirth", e.currentTarget.value)}
              />
            </label>

            <label className="form-field">
              <span className="form-label">Status studi</span>
              <select
                className="form-select"
                value={form.enrollmentStatus}
                onChange={(e) =>
                  updateField("enrollmentStatus", e.currentTarget.value as EnrollmentStatus | "")
                }
              >
                <option value="">— Pilih —</option>
                {ENROLLMENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span className="form-label">Jenjang studi</span>
              <select
                className="form-select"
                value={form.educationLevel}
                onChange={(e) =>
                  updateField("educationLevel", e.currentTarget.value as EducationLevel | "")
                }
              >
                <option value="">— Pilih —</option>
                {EDUCATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span className="form-label">Nama universitas</span>
              <input
                className="form-input"
                type="text"
                value={form.universityName}
                onChange={(e) => updateField("universityName", e.currentTarget.value)}
                maxLength={200}
              />
            </label>

            <label className="form-field">
              <span className="form-label">Nomor mahasiswa</span>
              <input
                className="form-input"
                type="text"
                value={form.studentIdNumber}
                onChange={(e) => updateField("studentIdNumber", e.currentTarget.value)}
                maxLength={64}
              />
            </label>
          </div>

          <div className="record-actions">
            <button
              type="submit"
              disabled={isSaving}
              className="ui-button"
              data-variant="primary"
              data-size="md"
            >
              {isSaving ? "Menyimpan..." : "Simpan"}
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => void loadEligibility()}
              className="ui-button"
              data-variant="outline"
              data-size="md"
            >
              Muat ulang
            </button>
          </div>
        </form>
      )}
    </main>
  );
};
