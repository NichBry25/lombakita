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
import { Button, Feedback, Icon, IconButton } from "@/components/ui";

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
  // DEC-0131's third predicate, resolved server-side from ANY member's registration row: a bukti
  // transfer exists on the team's payment group in ANY status. When true the team cancel control is
  // WITHHELD. A team pays once, so this is a fact about the team, not about the captain.
  cancellationClosedByPaymentProof: boolean;
  // DEC-0170, same rule as the individual path: with the organiser unable to take payment there is
  // nothing a new team can usefully do, so the controls are WITHHELD rather than left to be refused.
  //
  // THAT INCLUDES CREATING THE TEAM AT ALL, not only registering it. This flag reached the roster's
  // register action and stopped there, so a candidate could still form a team, become its captain
  // and invite people into it for a competition that cannot accept a registration. The individual
  // path withheld its one control while the team path withheld its last one. Individual and team
  // are siblings on every condition in this lane, entry paths included.
  registrationWithheld: boolean;
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
          <h2>Tim</h2>
          <p>
            {props.competitionMode !== "both"
              ? "Kompetisi ini wajib didaftarkan sebagai tim."
              : props.registrationWithheld
                ? // The individual "Daftar" control is withheld in this state, so pointing at it
                  // would send the candidate looking for a button that is deliberately absent.
                  "Kompetisi ini menerima pendaftaran tim maupun individu."
                : "Anda dapat mendaftar sebagai tim atau secara individu (di tombol Daftar di atas)."}
          </p>
        </div>
      </div>

      {props.initialTeam ? (
        <TeamRoster {...props} team={props.initialTeam} />
      ) : props.registrationWithheld ? (
        /* Stands where the create-team form would have been, for the same reason the individual
           card carries its own sentence: a card with its form removed and nothing in its place
           says only that something is missing. */
        <Feedback tone="neutral">
          Pembuatan tim belum dapat dibuka selama penyelenggara belum bisa menerima pembayaran.
        </Feedback>
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
        <Button type="submit" loading={busy} variant="primary" size="md">
          Buat tim
        </Button>
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
          Batalkan pendaftaran tim
        </Button>
      </div>
    </div>
  );
}

const TEAM_CANCEL_MESSAGE: Record<string, string> = {
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
};

function TeamRoster(props: Props & { team: TeamSnapshot }) {
  const router = useRouter();
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();
  const { team } = props;
  const isCaptain = team.captainId === props.expectedUserId;
  const status = team.status;

  // The roster runs many one-off actions from the same component. Tracking *which* one is in
  // flight (rather than a single boolean) puts the spinner on the button the user pressed while
  // still locking every other control.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const busy = pendingAction !== null;
  // a username OR an email; resolved server-side.
  const [inviteIdentifier, setInviteIdentifier] = useState("");

  const ownMembership = props.initialMembers.find((m) => m.userId === props.expectedUserId);

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

  useEffect(() => {
    if (atCapacity) {
      addToast({ type: "warning", message: "Tim telah mencapai kapasitas maksimum." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atCapacity]);

  useEffect(() => {
    if (isCaptain && submitDisabledReason && status === "forming") {
      addToast({ type: "warning", message: submitDisabledReason });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaptain, submitDisabledReason, status]);

  useEffect(() => {
    if (!isCaptain && ownMembership) {
      addToast({
        type: "info",
        message: `Hanya kapten (${team.captainId.slice(0, 8)}…) yang dapat mendaftarkan atau membubarkan tim.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaptain, ownMembership]);

  const executeAction = async (
    actionKey: string,
    label: string,
    url: string,
    init: RequestInit,
  ) => {
    setPendingAction(actionKey);
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
      setPendingAction(null);
    }
  };

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeAction("invite", "mengirim undangan", `/api/v1/teams/${team.id}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitedIdentifier: inviteIdentifier }),
    });
    setInviteIdentifier("");
  };

  const onCancelInvite = (tokenHash: string) =>
    executeAction(
      `cancel-invite:${tokenHash}`,
      "membatalkan undangan",
      `/api/v1/teams/${team.id}/invitations/${tokenHash}`,
      { method: "DELETE" },
    );

  const onRemoveMember = (membershipId: string) =>
    executeAction(
      `remove-member:${membershipId}`,
      "menghapus anggota",
      `/api/v1/teams/${team.id}/memberships/${membershipId}`,
      { method: "DELETE" },
    );

  const onDisband = () =>
    openModal({
      title: "Bubarkan tim",
      body: "Bubarkan tim? Tindakan ini tidak dapat dibatalkan.",
      actions: [
        {
          label: "Bubarkan tim",
          autoClose: true,
          onClick: () => {
            void executeAction("disband", "membubarkan tim", `/api/v1/teams/${team.id}`, {
              method: "DELETE",
            });
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
              `leave:${membershipId}`,
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
      "submit-team",
      "mendaftarkan tim",
      `/api/v1/competitions/${props.competitionId}/teams/${team.id}/registrations`,
      { method: "POST" },
    );

  const submitTeamCancel = async (reason: string) => {
    closeModal();
    setPendingAction("cancel-submission");
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
      setPendingAction(null);
    }
  };

  const onCancelSubmission = () =>
    openModal({
      title: "Batalkan pendaftaran tim",
      closeable: true,
      actions: [],
      body: <TeamCancelReasonForm onConfirm={submitTeamCancel} onCancel={closeModal} />,
    });

  // Warn on hard navigation (URL change, tab close, refresh) when team is incomplete.
  useEffect(() => {
    if (!sizeBelowMin || status !== "forming") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [sizeBelowMin, status]);

  // Offer to save the competition as a bookmark when backing out with an incomplete team.
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
              <IconButton
                icon="trash"
                label={`Keluarkan ${m.displayName ?? m.email} dari tim`}
                onClick={() => onRemoveMember(m.membershipId)}
                loading={pendingAction === `remove-member:${m.membershipId}`}
                disabled={busy}
                variant="danger"
                size="sm"
              />
            )}
            {!isCaptain && m.userId === props.expectedUserId && status === "forming" && (
              <Button
                onClick={() => onLeave(m.membershipId)}
                loading={pendingAction === `leave:${m.membershipId}`}
                disabled={busy}
                variant="danger"
                size="sm"
              >
                Tinggalkan
              </Button>
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
                  <Button
                    onClick={() => onCancelInvite(p.tokenHash)}
                    loading={pendingAction === `cancel-invite:${p.tokenHash}`}
                    disabled={busy}
                    variant="danger"
                    size="sm"
                  >
                    Batalkan
                  </Button>
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
              placeholder="Username atau Email"
              required
              disabled={busy || atCapacity}
              className="form-input"
            />
            <Button
              type="submit"
              loading={pendingAction === "invite"}
              disabled={busy || atCapacity}
              variant="primary"
              size="md"
            >
              Undang
            </Button>
          </form>
        </>
      )}

      {isCaptain && (
        <div className="team-primary-actions">
          {status === "forming" && !props.registrationWithheld && (
            <Button
              onClick={onSubmitTeam}
              loading={pendingAction === "submit-team"}
              disabled={busy || submitDisabledReason !== null}
              title={submitDisabledReason ?? ""}
              variant="primary"
              size="md"
            >
              Daftarkan tim
            </Button>
          )}
          {status === "submitted" && !props.cancellationClosedByPaymentProof && (
            <Button
              onClick={onCancelSubmission}
              loading={pendingAction === "cancel-submission"}
              disabled={busy}
              variant="danger"
              size="md"
            >
              Batalkan pendaftaran tim
            </Button>
          )}
          {status === "forming" && (
            <Button
              onClick={onDisband}
              loading={pendingAction === "disband"}
              disabled={busy}
              variant="danger"
              size="md"
            >
              Bubarkan tim
            </Button>
          )}
        </div>
      )}

      {/* Stands where the cancel control would have been, and only for the captain. A member who
          never had the control needs no explanation of its absence. */}
      {isCaptain && status === "submitted" && props.cancellationClosedByPaymentProof && (
        <Feedback tone="neutral">
          Pendaftaran tim tidak dapat dibatalkan sendiri setelah bukti transfer dikirim. Hubungi
          penyelenggara jika ada kekeliruan.
        </Feedback>
      )}

      {sizeBelowMin && status === "forming" && (
        <div>
          <Button
            type="button"
            onClick={handleBackOut}
            variant="ghost"
            size="sm"
            leadingIcon={<Icon name="arrow-left" size="sm" />}
          >
            Detail kompetisi
          </Button>
        </div>
      )}
    </div>
  );
}
