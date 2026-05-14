"use client";

import { useCallback, useEffect, useState } from "react";

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

export const StudentEligibilityShell = () => {
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

    const response = await fetch("/api/v1/students/me/eligibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      setFeedback({ type: "error", message: await extractErrorMessage(response) });
      setIsSaving(false);
      return;
    }

    const data = (await response.json()) as EligibilityResponse;
    applyResponse(data);
    setFeedback({ type: "success", message: "Data kelayakan berhasil diperbarui." });
    setIsSaving(false);
  };

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>Kelayakan Mahasiswa</h1>
      <p style={{ fontSize: 13, color: "#555", marginBottom: 20 }}>
        Lengkapi data berikut untuk mengikuti pendaftaran kompetisi. Semua data dievaluasi di
        server saat dibutuhkan.
      </p>

      {feedback && (
        <div
          role="status"
          style={{
            padding: "10px 14px",
            marginBottom: 16,
            borderRadius: 6,
            fontSize: 13,
            border: feedback.type === "success" ? "1px solid #8fcf8f" : "1px solid #e09090",
            background: feedback.type === "success" ? "#eff8ef" : "#fbeded",
            color: feedback.type === "success" ? "#1f5f1f" : "#7a1f1f",
          }}
        >
          {feedback.message}
        </div>
      )}

      {eligibility && (
        <section
          style={{
            border: "1px solid #d4d4d8",
            borderRadius: 8,
            padding: 16,
            marginBottom: 20,
            background: "#fafafa",
          }}
        >
          <p style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Status saat ini</p>
          <p
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: eligibility.status === "eligible" ? "#1f5f1f" : "#7a1f1f",
              marginBottom: 8,
            }}
            data-testid="eligibility-status"
          >
            {STATUS_LABEL[eligibility.status]}
          </p>
          {eligibility.reasons.length > 0 && (
            <ul
              style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#555" }}
              data-testid="eligibility-reasons"
            >
              {eligibility.reasons.map((reason) => (
                <li key={reason}>{formatReason(reason)}</li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
            Diperiksa: {new Date(eligibility.checkedAt).toLocaleString("id-ID")}
          </p>
        </section>
      )}

      {isLoading ? (
        <p style={{ fontSize: 13, color: "#555" }}>Memuat...</p>
      ) : (
        <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Tanggal lahir</span>
            <input
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => updateField("dateOfBirth", e.currentTarget.value)}
              style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 }}
            />
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Status studi</span>
            <select
              value={form.enrollmentStatus}
              onChange={(e) =>
                updateField("enrollmentStatus", e.currentTarget.value as EnrollmentStatus | "")
              }
              style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 }}
            >
              <option value="">— Pilih —</option>
              {ENROLLMENT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Jenjang studi</span>
            <select
              value={form.educationLevel}
              onChange={(e) =>
                updateField("educationLevel", e.currentTarget.value as EducationLevel | "")
              }
              style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 }}
            >
              <option value="">— Pilih —</option>
              {EDUCATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Nama universitas</span>
            <input
              type="text"
              value={form.universityName}
              onChange={(e) => updateField("universityName", e.currentTarget.value)}
              maxLength={200}
              style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 }}
            />
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Nomor mahasiswa</span>
            <input
              type="text"
              value={form.studentIdNumber}
              onChange={(e) => updateField("studentIdNumber", e.currentTarget.value)}
              maxLength={64}
              style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 }}
            />
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              disabled={isSaving}
              style={{
                padding: "8px 16px",
                background: "#355795",
                color: "white",
                border: "none",
                borderRadius: 4,
                fontSize: 13,
                cursor: isSaving ? "not-allowed" : "pointer",
              }}
            >
              {isSaving ? "Menyimpan..." : "Simpan"}
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => void loadEligibility()}
              style={{
                padding: "8px 16px",
                background: "white",
                color: "#355795",
                border: "1px solid #355795",
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              Muat ulang
            </button>
          </div>
        </form>
      )}
    </main>
  );
};
