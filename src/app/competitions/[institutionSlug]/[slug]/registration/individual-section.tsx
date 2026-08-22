"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Feedback } from "@/components/ui";
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
  // DEC-0131's third predicate, resolved server-side: a bukti transfer exists on this
  // registration's payment group in ANY status. When true the cancel control is WITHHELD, not
  // rendered disabled, and not rendered and then refused.
  cancellationClosedByPaymentProof: boolean;
  // The organiser cannot take payment, so a new entrant has nothing to do here. The register
  // control is WITHHELD rather than disabled, and the sentence explaining its absence takes its
  // place. A disabled "Daftar" invites a candidate to look for the permission that would enable it,
  // and no permission of theirs would.
  registrationWithheld: boolean;
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
  // The organiser cannot take payment right now: unverified, no published account, or no fee rule
  // in force. All three collapse to one code server-side so none of them leaks, and none of them is
  // the candidate's to fix. The generic "coba lagi" fallback was worse than nothing here: it
  // describes a transient fault and invites a candidate to retry something that will never succeed.
  registration_payment_unavailable:
    "Penyelenggara kompetisi ini belum dapat menerima pembayaran, jadi pendaftaran berbayar belum bisa diproses. Hubungi penyelenggara.",
  cancellation_not_supported_for_paid:
    "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim.",
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
  cancellationClosedByPaymentProof,
  registrationWithheld,
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
          <h2>Individu</h2>
        </div>
      </div>

      {registration && registration.status === "confirmed" ? (
        <>
          <div className="registration-state stack-sm">
            <span className="status-badge" data-status="open">
              ✓ Terdaftar
            </span>
            {cancellationClosedByPaymentProof ? null : (
              <div className="stack-xs">
                <Button onClick={handleCancel} loading={loading} variant="danger" size="sm">
                  Batalkan pendaftaran
                </Button>
                <p className="form-help">Pembatalan tunduk pada kebijakan penyelenggara.</p>
              </div>
            )}
          </div>
          {/* WITHHELD, not disabled. A disabled cancel button next to a registration the candidate
              believes they have paid for reads as a permission they might be able to obtain; the
              rule is that the decision has left their hands, and the sentence says so.

              It stands OUTSIDE the panel above, and has to. The neutral tone paints the inset
              ground, which is exactly what `.registration-state` paints, so a neutral note placed
              inside that panel renders background on background and the explanation disappears.
              The team section's equivalent note sits in `.team-roster`, which sets no background,
              so it needs no such placement. */}
          {cancellationClosedByPaymentProof ? (
            <Feedback tone="neutral">
              Pendaftaran tidak dapat dibatalkan sendiri setelah bukti transfer dikirim. Hubungi
              penyelenggara jika ada kekeliruan.
            </Feedback>
          ) : null}
        </>
      ) : registration && registration.status === "cancelled" ? (
        <div className="registration-state stack-xs">
          <span className="status-badge" data-status="closed">
            Pendaftaran dibatalkan
          </span>
          <p className="form-help">Pendaftaran ulang belum tersedia.</p>
        </div>
      ) : registrationWithheld ? (
        /* Stands where the register control would have been. An empty card is the same failure the
           withholding exists to avoid: it removes the control and leaves the candidate to work out
           why on their own. */
        <Feedback tone="neutral">
          Pendaftaran individu belum dapat dibuka selama penyelenggara belum bisa menerima
          pembayaran.
        </Feedback>
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
