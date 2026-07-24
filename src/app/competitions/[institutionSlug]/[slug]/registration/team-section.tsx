"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { getTeamRoleLabel } from "@/lib/access/role-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { useModal, useToast } from "@/components/ui/primitives";

type Member = {
  membershipId: string;
  userId: string;
  role: "captain" | "member" | string;
  displayName: string | null;
  email: string;
};

type PendingInvitation = {
  id: string;
  tokenHash: string;
  invitedEmail: string;
  expiresAt: string;
};

type TeamSnapshot = {
  id: string;
  name: string;
  captainId: string;
  status: "forming" | "submitted" | "cancelled" | string;
};

type Props = {
  competitionId: string;
  competitionMode: "individual" | "team" | "both" | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationOpen: boolean;
  expectedUserId: string;
  initialTeam: TeamSnapshot | null;
  initialMembers: Member[];
  initialPendingInvitations: PendingInvitation[];
};

type ApiError = { code: string; message: string; details?: Record<string, unknown> };

const TEAM_STATUS_LABELS: Record<string, string> = {
  forming: "Pembentukan",
  submitted: "Terdaftar",
  cancelled: "Dibatalkan",
};

const getTeamStatusLabel = (status: string): string =>
  TEAM_STATUS_LABELS[status] ?? formatDisplayToken(status);

const handleError = async (res: Response): Promise<ApiError> => {
  const code = (await readErrorCode(res)) ?? `http_${res.status}`;
  if (code === SESSION_MISMATCH_CODE) {
    return { code, message: SESSION_MISMATCH_MESSAGE };
  }
  try {
    const body = await res.clone().json();
    return {
      code,
      message: body?.error?.message ?? `Request failed with status ${res.status}`,
      details: body?.error?.details,
    };
  } catch {
    return { code, message: `Request failed with status ${res.status}` };
  }
};

export function CompetitionTeamSection(props: Props) {
  // Section only meaningful when the competition supports teams.
  const supportsTeams = props.competitionMode === "team" || props.competitionMode === "both";
  if (!supportsTeams) return null;

  return (
    <section className="content-section registration-path-card team-registration-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Jalur 02</p>
          <h2>Tim</h2>
          <p>
            {props.competitionMode === "both"
              ? "Anda dapat mendaftar sebagai tim atau secara individu (di tombol Daftar di atas)."
              : "Kompetisi ini wajib didaftarkan sebagai tim."}
          </p>
        </div>
      </div>

      {props.initialTeam ? (
        <TeamRoster {...props} team={props.initialTeam} />
      ) : (
        <CreateTeamForm {...props} />
      )}
    </section>
  );
}

function CreateTeamForm(props: Props) {
  const router = useRouter();
  const { addToast } = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await sessionFetch(
        props.expectedUserId,
        `/api/v1/competitions/${props.competitionId}/teams`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) {
        const err = await handleError(res);
        addToast({ type: "error", message: err.message });
        return;
      }
      router.refresh();
      setName("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="team-create stack-md">
      <div className="stack-xs">
        <h3>Buat tim</h3>
        <p className="muted-copy">Anda akan menjadi kapten setelah membuat tim.</p>
      </div>
      <form onSubmit={onSubmit} className="team-inline-form">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama tim"
          required
          className="form-input"
        />
        <button
          type="submit"
          disabled={busy}
          className="ui-button"
          data-variant="primary"
          data-size="md"
        >
          {busy ? "Membuat…" : "Buat tim"}
        </button>
      </form>
    </div>
  );
}

// Self-contained modal body: required cancellation reason + its own confirm/cancel buttons.
function TeamCancelReasonForm({
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
      <p className="muted-copy">
        Tim akan kembali ke status &apos;forming&apos; dan semua pendaftaran tim dibatalkan.
        Tuliskan alasan pembatalan (wajib diisi).
      </p>
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
        <button
          type="button"
          onClick={onCancel}
          className="ui-button"
          data-variant="outline"
          data-size="sm"
        >
          Kembali
        </button>
        <button
          type="button"
          disabled={trimmed.length === 0}
          onClick={() => onConfirm(trimmed)}
          className="ui-button"
          data-variant="danger"
          data-size="sm"
        >
          Batalkan pendaftaran tim
        </button>
      </div>
    </div>
  );
}

const TEAM_CANCEL_MESSAGE: Record<string, string> = {
  cancellation_reason_required: "Alasan pembatalan wajib diisi.",
  cancellation_reason_too_long: "Alasan pembatalan terlalu panjang (maksimal 500 karakter).",
  cancellation_not_supported_for_paid: "Pendaftaran berbayar belum dapat dibatalkan.",
  cancellation_disabled_by_institution:
    "Penyelenggara tidak mengizinkan pembatalan untuk kompetisi ini.",
  cancellation_window_closed: "Batas waktu pembatalan telah terlewat.",
};

function TeamRoster(props: Props & { team: TeamSnapshot }) {
  const router = useRouter();
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();
  const { team } = props;
  const isCaptain = team.captainId === props.expectedUserId;
  const status = team.status;

  const [busy, setBusy] = useState(false);
  // a username OR an email; resolved server-side.
  const [inviteIdentifier, setInviteIdentifier] = useState("");

  const seatsUsed = props.initialMembers.length + props.initialPendingInvitations.length;
  const atCapacity = props.maxTeamSize !== null && seatsUsed >= props.maxTeamSize;

  // Submission gate hints (UI-side mirror of server checks; server is authoritative).
  const memberCount = props.initialMembers.length;
  const sizeBelowMin = props.minTeamSize !== null && memberCount < props.minTeamSize;
  const sizeAboveMax = props.maxTeamSize !== null && memberCount > props.maxTeamSize;
  const submitDisabledReason = (() => {
    if (status !== "forming") return `Tim sudah berstatus '${getTeamStatusLabel(status)}'`;
    if (!props.registrationOpen) return "Pendaftaran kompetisi belum dibuka atau sudah ditutup";
    if (sizeBelowMin) return `Tim membutuhkan minimal ${props.minTeamSize} anggota aktif`;
    if (sizeAboveMax) return `Tim melebihi maksimum ${props.maxTeamSize} anggota aktif`;
    return null;
  })();

  const executeAction = async (label: string, url: string, init: RequestInit) => {
    setBusy(true);
    try {
      const res = await sessionFetch(props.expectedUserId, url, init);
      if (!res.ok) {
        const err = await handleError(res);
        addToast({ type: "error", message: err.message });
        return;
      }
      router.refresh();
    } catch {
      addToast({ type: "error", message: `Gagal ${label}.` });
    } finally {
      setBusy(false);
    }
  };

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeAction("mengirim undangan", `/api/v1/teams/${team.id}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitedIdentifier: inviteIdentifier }),
    });
    setInviteIdentifier("");
  };

  const onCancelInvite = (tokenHash: string) =>
    executeAction("membatalkan undangan", `/api/v1/teams/${team.id}/invitations/${tokenHash}`, {
      method: "DELETE",
    });

  const onRemoveMember = (membershipId: string) =>
    executeAction("menghapus anggota", `/api/v1/teams/${team.id}/memberships/${membershipId}`, {
      method: "DELETE",
    });

  const onDisband = () =>
    openModal({
      title: "Bubarkan tim",
      body: "Bubarkan tim? Tindakan ini tidak dapat dibatalkan.",
      actions: [
        {
          label: "Bubarkan tim",
          autoClose: true,
          onClick: () => {
            void executeAction("membubarkan tim", `/api/v1/teams/${team.id}`, { method: "DELETE" });
          },
        },
        { label: "Batal", onClick: () => {} },
      ],
    });

  const onLeave = (membershipId: string) =>
    openModal({
      title: "Tinggalkan tim",
      body: "Tinggalkan tim?",
      actions: [
        {
          label: "Tinggalkan",
          autoClose: true,
          onClick: () => {
            void executeAction(
              "meninggalkan tim",
              `/api/v1/teams/${team.id}/memberships/${membershipId}`,
              { method: "DELETE" },
            );
          },
        },
        { label: "Batal", onClick: () => {} },
      ],
    });

  const onSubmitTeam = () =>
    executeAction(
      "mendaftarkan tim",
      `/api/v1/competitions/${props.competitionId}/teams/${team.id}/registrations`,
      { method: "POST" },
    );

  const submitTeamCancel = async (reason: string) => {
    closeModal();
    setBusy(true);
    try {
      const res = await sessionFetch(
        props.expectedUserId,
        `/api/v1/competitions/${props.competitionId}/teams/${team.id}/registrations`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cancellationReason: reason }),
        },
      );
      if (!res.ok) {
        const e = await handleError(res);
        addToast({ type: "error", message: TEAM_CANCEL_MESSAGE[e.code] ?? e.message });
        return;
      }
      addToast({ type: "success", message: "Pendaftaran tim dibatalkan." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan. Coba lagi." });
    } finally {
      setBusy(false);
    }
  };

  const onCancelSubmission = () =>
    openModal({
      title: "Batalkan pendaftaran tim",
      closeable: true,
      actions: [],
      body: <TeamCancelReasonForm onConfirm={submitTeamCancel} onCancel={closeModal} />,
    });

  // F16: warn on hard navigation (URL change, tab close, refresh) when team is incomplete.
  useEffect(() => {
    if (!sizeBelowMin || status !== "forming") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [sizeBelowMin, status]);

  // F16: offer to save the competition as a bookmark when backing out with an incomplete team.
  const handleBackOut = () => {
    if (!sizeBelowMin || status !== "forming") {
      router.back();
      return;
    }
    const saveAndBack = async () => {
      try {
        await sessionFetch(
          props.expectedUserId,
          `/api/v1/competitions/${props.competitionId}/save`,
          { method: "POST" },
        );
      } catch {
        addToast({ type: "error", message: "Gagal menyimpan kompetisi. Silakan coba lagi." });
      }
      router.back();
    };
    openModal({
      title: "Tim belum lengkap",
      body: "Tim Anda belum memiliki cukup anggota. Simpan kompetisi ini ke daftar simpanan sebelum keluar?",
      closeable: true,
      actions: [
        {
          label: "Simpan & keluar",
          variant: "primary",
          autoClose: true,
          onClick: () => {
            void saveAndBack();
          },
        },
        {
          label: "Keluar tanpa menyimpan",
          variant: "secondary",
          autoClose: true,
          onClick: () => {
            router.back();
          },
        },
      ],
    });
  };

  const ownMembership = props.initialMembers.find((m) => m.userId === props.expectedUserId);

  return (
    <div className="team-roster">
      <div className="team-roster-header">
        <div className="stack-xs">
          <div className="cluster">
            <h3>{team.name}</h3>
            <span className="status-badge" data-team-status={status}>
              {getTeamStatusLabel(status)}
            </span>
          </div>
          <p className="record-meta">
            {seatsUsed}
            {props.maxTeamSize !== null ? ` / ${props.maxTeamSize}` : ""} kursi terpakai
            {props.minTeamSize !== null || props.maxTeamSize !== null
              ? ` (rentang: ${props.minTeamSize ?? "—"} – ${props.maxTeamSize ?? "—"})`
              : ""}
          </p>
        </div>
      </div>

      <h3 className="team-subheading">Anggota</h3>
      <ul className="team-member-list">
        {props.initialMembers.map((m) => (
          <li key={m.membershipId} className="team-member-row">
            <span className="team-member-main">
              <span className="team-member-name">
                {m.displayName ?? m.email}{" "}
                <span className="record-meta">({getTeamRoleLabel(m.role)})</span>
              </span>
            </span>
            {isCaptain && m.role !== "captain" && status === "forming" && (
              <button
                onClick={() => onRemoveMember(m.membershipId)}
                disabled={busy}
                className="ui-button"
                data-variant="danger"
                data-size="sm"
              >
                Hapus
              </button>
            )}
            {!isCaptain && m.userId === props.expectedUserId && status === "forming" && (
              <button
                onClick={() => onLeave(m.membershipId)}
                disabled={busy}
                className="ui-button"
                data-variant="danger"
                data-size="sm"
              >
                Tinggalkan
              </button>
            )}
          </li>
        ))}
      </ul>

      {props.initialPendingInvitations.length > 0 && (
        <>
          <h3 className="team-subheading">Undangan tertunda</h3>
          <ul className="team-member-list">
            {props.initialPendingInvitations.map((p) => (
              <li key={p.id} className="team-member-row">
                <span className="team-member-name">{p.invitedEmail}</span>
                {isCaptain && status === "forming" && (
                  <button
                    onClick={() => onCancelInvite(p.tokenHash)}
                    disabled={busy}
                    className="ui-button"
                    data-variant="danger"
                    data-size="sm"
                  >
                    Batalkan
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {isCaptain && status === "forming" && (
        <>
          <h3 className="team-subheading">Undang anggota</h3>
          <form onSubmit={onInvite} className="team-inline-form">
            <input
              type="text"
              value={inviteIdentifier}
              onChange={(e) => setInviteIdentifier(e.target.value)}
              placeholder="Username atau email"
              required
              disabled={busy || atCapacity}
              className="form-input"
            />
            <button
              type="submit"
              disabled={busy || atCapacity}
              className="ui-button"
              data-variant="primary"
              data-size="md"
            >
              Undang
            </button>
          </form>
          {atCapacity && <p className="form-error">Tim telah mencapai kapasitas maksimum.</p>}
        </>
      )}

      {isCaptain && (
        <div className="team-primary-actions">
          {status === "forming" && (
            <button
              onClick={onSubmitTeam}
              disabled={busy || submitDisabledReason !== null}
              title={submitDisabledReason ?? ""}
              className="ui-button"
              data-variant="primary"
              data-size="md"
            >
              {busy ? "Memproses…" : "Daftarkan tim"}
            </button>
          )}
          {status === "submitted" && (
            <button
              onClick={onCancelSubmission}
              disabled={busy}
              className="ui-button"
              data-variant="danger"
              data-size="md"
            >
              Batalkan pendaftaran tim
            </button>
          )}
          {status === "forming" && (
            <button
              onClick={onDisband}
              disabled={busy}
              className="ui-button"
              data-variant="danger"
              data-size="md"
            >
              Bubarkan tim
            </button>
          )}
        </div>
      )}

      {isCaptain && submitDisabledReason && status === "forming" && (
        <p className="form-error">{submitDisabledReason}</p>
      )}

      {sizeBelowMin && status === "forming" && (
        <div>
          <button
            type="button"
            onClick={handleBackOut}
            className="ui-button"
            data-variant="ghost"
            data-size="sm"
          >
            ← Kembali ke detail kompetisi
          </button>
        </div>
      )}

      {!isCaptain && ownMembership && (
        <p className="feedback" data-tone="info">
          Hanya kapten ({team.captainId.slice(0, 8)}…) yang dapat mendaftarkan atau membubarkan tim.
        </p>
      )}
    </div>
  );
}
