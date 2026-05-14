"use client";

import { useState } from "react";

type RegistrationStatus = "confirmed" | "cancelled" | "pending_payment";

type Registration = {
  id: string;
  status: RegistrationStatus;
};

type CTAState = "open" | "closed" | "not_yet_open";

type Props = {
  competitionId: string;
  ctaState: CTAState;
  // Initial registration record fetched server-side. null = no registration yet.
  initialRegistration: Registration | null;
  // True when the competition mode does not accept individual entry (team-only).
  wrongMode: boolean;
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
};

const messageFor = (code: string | undefined): string =>
  (code && ERROR_MESSAGES[code]) ?? "Terjadi kesalahan. Coba lagi.";

export function RegisterButton({ competitionId, ctaState, initialRegistration, wrongMode }: Props) {
  const [registration, setRegistration] = useState<Registration | null>(initialRegistration);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/competitions/${competitionId}/registrations`, {
        method: "POST",
      });
      const body = (await res.json()) as { registration?: Registration; error?: { code?: string } };
      if (!res.ok || !body.registration) {
        setError(messageFor(body.error?.code));
      } else {
        setRegistration(body.registration);
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
      const res = await fetch(
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
      }
    } catch {
      setError("Terjadi kesalahan jaringan. Coba lagi.");
    } finally {
      setLoading(false);
    }
  };

  // Render: confirmed registration → status badge + cancel
  if (registration && registration.status === "confirmed") {
    const canCancel = ctaState === "open";
    return (
      <div>
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
        <div style={{ marginTop: 8 }}>
          <button
            onClick={handleCancel}
            disabled={loading || !canCancel}
            style={{
              padding: "6px 14px",
              background: canCancel ? "#fff" : "#f0f0f0",
              color: canCancel ? "#c0392b" : "#999",
              border: "1px solid #c0392b",
              borderRadius: 6,
              fontSize: 13,
              cursor: loading ? "wait" : canCancel ? "pointer" : "not-allowed",
            }}
          >
            {loading ? "..." : "Batalkan Pendaftaran"}
          </button>
          {!canCancel && (
            <p style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
              Pembatalan tidak tersedia setelah batas waktu.
            </p>
          )}
        </div>
        {error && <p style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>{error}</p>}
      </div>
    );
  }

  // Render: cancelled — terminal in MVP (re-registration deferred)
  if (registration && registration.status === "cancelled") {
    return (
      <div>
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
          Pendaftaran Dibatalkan
        </div>
        <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
          Pendaftaran ulang tidak tersedia untuk MVP.
        </p>
      </div>
    );
  }

  // Render: no registration — register CTA, gated by ctaState + mode.
  const blocked = ctaState !== "open" || wrongMode;
  const blockedReason = wrongMode
    ? "Kompetisi ini hanya menerima pendaftaran tim."
    : ctaState === "not_yet_open"
      ? "Pendaftaran belum dibuka."
      : ctaState === "closed"
        ? "Pendaftaran ditutup."
        : null;

  return (
    <div>
      <button
        onClick={handleRegister}
        disabled={loading || blocked}
        style={{
          padding: "10px 24px",
          background: blocked ? "#ccc" : "#355795",
          color: blocked ? "#555" : "#fff",
          borderRadius: 6,
          border: "none",
          fontSize: 15,
          cursor: loading ? "wait" : blocked ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "..." : "Daftar"}
      </button>
      {blockedReason && (
        <p style={{ fontSize: 12, color: "#888", marginTop: 6 }}>{blockedReason}</p>
      )}
      {error && <p style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>{error}</p>}
    </div>
  );
}
