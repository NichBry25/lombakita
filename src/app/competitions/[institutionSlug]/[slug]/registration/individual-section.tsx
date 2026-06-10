"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useModal, useToast } from "@/components/ui/primitives";
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
  cancellation_reason_required: "Alasan pembatalan wajib diisi.",
  cancellation_reason_too_long: "Alasan pembatalan terlalu panjang (maksimal 500 karakter).",
  cancellation_not_supported_for_paid: "Pendaftaran berbayar belum dapat dibatalkan.",
  cancellation_disabled_by_institution:
    "Penyelenggara tidak mengizinkan pembatalan untuk kompetisi ini.",
  cancellation_window_closed: "Batas waktu pembatalan telah terlewat.",
  [SESSION_MISMATCH_CODE]: SESSION_MISMATCH_MESSAGE,
};

const messageFor = (code: string | undefined): string =>
  (code && ERROR_MESSAGES[code]) ?? "Terjadi kesalahan. Coba lagi.";

// Self-contained modal body: collects the required cancellation reason and renders its own
// confirm/cancel buttons (the modal is opened with no footer actions).
function CancelReasonForm({
  onConfirm,
  onCancel,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <div>
      <p style={{ marginTop: 0, fontSize: 14 }}>
        Tuliskan alasan pembatalan pendaftaran Anda. Alasan wajib diisi.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="Alasan pembatalan"
        aria-label="Alasan pembatalan"
        style={{ display: "block", width: "100%" }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onCancel}>
          Kembali
        </button>
        <button
          type="button"
          disabled={trimmed.length === 0}
          onClick={() => onConfirm(trimmed)}
          style={{
            background: trimmed.length === 0 ? "#f0f0f0" : "#c0392b",
            color: trimmed.length === 0 ? "#999" : "#fff",
            border: "1px solid #c0392b",
            borderRadius: 6,
            padding: "6px 14px",
            cursor: trimmed.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          Batalkan Pendaftaran
        </button>
      </div>
    </div>
  );
}

export function IndividualRegistrationSection({
  competitionId,
  ctaState,
  initialRegistration,
  expectedUserId,
  modeLabel,
}: Props) {
  const router = useRouter();
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();
  const [registration, setRegistration] = useState<Registration | null>(initialRegistration);
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    setLoading(true);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/registrations`,
        { method: "POST" },
      );
      const body = (await res.json()) as { registration?: Registration; error?: { code?: string } };
      if (!res.ok || !body.registration) {
        addToast({ type: "error", message: messageFor(body.error?.code) });
      } else {
        setRegistration(body.registration);
        router.refresh();
      }
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan. Coba lagi." });
    } finally {
      setLoading(false);
    }
  };

  const submitCancel = async (reason: string) => {
    if (!registration) return;
    closeModal();
    setLoading(true);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/registrations/${registration.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cancellationReason: reason }),
        },
      );
      const body = (await res.json()) as {
        registration?: Registration;
        error?: { code?: string };
      };
      if (!res.ok || !body.registration) {
        addToast({ type: "error", message: messageFor(body.error?.code) });
      } else {
        setRegistration(body.registration);
        addToast({ type: "success", message: "Pendaftaran dibatalkan." });
        router.refresh();
      }
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan. Coba lagi." });
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (!registration) return;
    openModal({
      title: "Batalkan Pendaftaran",
      closeable: true,
      actions: [],
      body: <CancelReasonForm onConfirm={submitCancel} onCancel={closeModal} />,
    });
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
              disabled={loading}
              style={{
                padding: "6px 14px",
                background: "#fff",
                color: "#c0392b",
                border: "1px solid #c0392b",
                borderRadius: 6,
                fontSize: 13,
                cursor: loading ? "wait" : "pointer",
              }}
            >
              {loading ? "..." : "Batalkan Pendaftaran"}
            </button>
            <p style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
              Pembatalan tunduk pada kebijakan penyelenggara.
            </p>
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

    </section>
  );
}
