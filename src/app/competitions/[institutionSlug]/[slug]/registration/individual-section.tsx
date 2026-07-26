"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
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
    <div className="stack-md">
      <p className="muted-copy">Tuliskan alasan pembatalan pendaftaran Anda. Alasan wajib diisi.</p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="Alasan pembatalan"
        aria-label="Alasan pembatalan"
        className="form-textarea"
      />
      <div className="modal-actions">
        <Button type="button" onClick={onCancel} variant="outline" size="sm">
          Kembali
        </Button>
        <Button
          type="button"
          disabled={trimmed.length === 0}
          onClick={() => onConfirm(trimmed)}
          variant="danger"
          size="sm"
        >
          Batalkan pendaftaran
        </Button>
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
      title: "Batalkan pendaftaran",
      closeable: true,
      actions: [],
      body: <CancelReasonForm onConfirm={submitCancel} onCancel={closeModal} />,
    });
  };

  return (
    <section className="content-section registration-path-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Jalur 01</p>
          <h2>Individu</h2>
        </div>
      </div>

      {registration && registration.status === "confirmed" ? (
        <div className="registration-state stack-sm">
          <span className="status-badge" data-status="open">
            ✓ Terdaftar
          </span>
          <div className="stack-xs">
            <Button onClick={handleCancel} loading={loading} variant="danger" size="sm">
              Batalkan pendaftaran
            </Button>
            <p className="form-help">Pembatalan tunduk pada kebijakan penyelenggara.</p>
          </div>
        </div>
      ) : registration && registration.status === "cancelled" ? (
        <div className="registration-state stack-xs">
          <span className="status-badge" data-status="closed">
            Pendaftaran dibatalkan
          </span>
          <p className="form-help">Pendaftaran ulang tidak tersedia untuk MVP.</p>
        </div>
      ) : (
        <Button
          onClick={handleRegister}
          loading={loading}
          disabled={ctaState !== "open"}
          className="registration-primary-action"
          variant="primary"
          size="lg"
        >
          {modeLabel}
        </Button>
      )}
    </section>
  );
}
