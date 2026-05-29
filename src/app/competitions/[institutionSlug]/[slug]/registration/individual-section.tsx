"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type RegistrationStatus = "confirmed" | "cancelled" | "pending_payment";

type Registration = {
  id: string;
  status: RegistrationStatus;
};

type CTAState = "open" | "closed" | "not_yet_open";

type Props = {
  competitionId: string;
  ctaState: CTAState;
  initialRegistration: Registration | null;
  expectedUserId: string;
  modeLabel: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  registration_ineligible:
    "Akun Anda belum memenuhi syarat. Lengkapi profil kelayakan terlebih dahulu.",
  competition_not_published: "Kompetisi tidak tersedia untuk pendaftaran.",
  competition_wrong_mode: "Kompetisi ini hanya menerima pendaftaran tim.",
  registration_deadline_passed: "Batas waktu pendaftaran telah terlewat.",
  registration_already_exists:
    "Anda sudah pernah mendaftar untuk kompetisi ini. Pendaftaran ulang tidak tersedia.",
  competition_not_found: "Kompetisi tidak ditemukan.",
  registration_not_found: "Pendaftaran tidak ditemukan.",
  registration_not_owner: "Anda tidak dapat membatalkan pendaftaran orang lain.",
  registration_wrong_status: "Pendaftaran ini sudah dibatalkan.",
  [SESSION_MISMATCH_CODE]: SESSION_MISMATCH_MESSAGE,
};

const messageFor = (code: string | undefined): string =>
  (code && ERROR_MESSAGES[code]) ?? "Terjadi kesalahan. Coba lagi.";

export function IndividualRegistrationSection({
  competitionId,
  ctaState,
  initialRegistration,
  expectedUserId,
  modeLabel,
}: Props) {
  const router = useRouter();
  const [registration, setRegistration] = useState<Registration | null>(initialRegistration);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/registrations`,
        { method: "POST" },
      );
      const body = (await res.json()) as { registration?: Registration; error?: { code?: string } };
      if (!res.ok || !body.registration) {
        setError(messageFor(body.error?.code));
      } else {
        setRegistration(body.registration);
        router.refresh();
      }
    } catch {
      setError("Terjadi kesalahan jaringan. Coba lagi.");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!registration) return;
    if (!window.confirm("Batalkan pendaftaran Anda untuk kompetisi ini?")) return;
    setLoading(true);
    setError(null);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/registrations/${registration.id}`,
        { method: "DELETE" },
      );
      const body = (await res.json()) as {
        registration?: Registration;
        error?: { code?: string };
      };
      if (!res.ok || !body.registration) {
        setError(messageFor(body.error?.code));
      } else {
        setRegistration(body.registration);
        router.refresh();
      }
    } catch {
      setError("Terjadi kesalahan jaringan. Coba lagi.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      style={{
        marginTop: 24,
        padding: 20,
        border: "1px solid #e5e5e5",
        borderRadius: 8,
        background: "#fbfbfd",
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>Individu</h2>

      {registration && registration.status === "confirmed" ? (
        <>
          <div
            style={{
              display: "inline-block",
              padding: "8px 16px",
              background: "#dff5dd",
              color: "#256029",
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            ✓ Terdaftar
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              onClick={handleCancel}
              disabled={loading || ctaState !== "open"}
              style={{
                padding: "6px 14px",
                background: ctaState === "open" ? "#fff" : "#f0f0f0",
                color: ctaState === "open" ? "#c0392b" : "#999",
                border: "1px solid #c0392b",
                borderRadius: 6,
                fontSize: 13,
                cursor:
                  loading ? "wait" : ctaState === "open" ? "pointer" : "not-allowed",
              }}
            >
              {loading ? "..." : "Batalkan Pendaftaran"}
            </button>
            {ctaState !== "open" && (
              <p style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
                Pembatalan tidak tersedia di luar jendela pendaftaran.
              </p>
            )}
          </div>
        </>
      ) : registration && registration.status === "cancelled" ? (
        <>
          <div
            style={{
              display: "inline-block",
              padding: "8px 16px",
              background: "#fdecea",
              color: "#a02020",
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Pendaftaran dibatalkan
          </div>
          <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
            Pendaftaran ulang tidak tersedia untuk MVP.
          </p>
        </>
      ) : (
        <button
          onClick={handleRegister}
          disabled={loading || ctaState !== "open"}
          style={{
            padding: "10px 24px",
            background: ctaState === "open" ? "#355795" : "#ccc",
            color: ctaState === "open" ? "#fff" : "#555",
            borderRadius: 6,
            border: "none",
            fontSize: 15,
            cursor: loading ? "wait" : ctaState === "open" ? "pointer" : "not-allowed",
          }}
        >
          {loading ? "..." : modeLabel}
        </button>
      )}

      {error && <p style={{ fontSize: 12, color: "#c0392b", marginTop: 12 }}>{error}</p>}
    </section>
  );
}
