"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { getTeamRoleLabel } from "@/lib/access/role-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { useModal, useToast } from "@/components/ui/primitives";
import { Button, Feedback, Icon, IconButton } from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";

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
  // A free competition counts open invites when a team registers, and a registered free team keeps
  // taking invites until registration closes. A paid competition still needs every member joined.
  isFreeCompetition: boolean;
  // Invites still pending and not expired, counted by the page on the server.
  openInvitationCount: number;
  registrationClosesAt: string | null;
  // A payment proof was sent for a cancelled registration of this team, so the server will not
  // register it again. The register control is withheld and a sentence stands in its place.
  registerAgainClosedByPaymentProof: boolean;
};

type SurfaceCopy = Partial<Record<string, string>>;

// The server's refusal and the note that replaces the register control say the same thing.
const TEAM_REGISTER_AGAIN_CLOSED_MESSAGE =
  "Pendaftaran ulang tim tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran tim ini.";

const TEAM_ERROR_COPY: SurfaceCopy = {
  forbidden: "Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk melanjutkan.",
  team_invalid_name: "Nama tim harus 2 sampai 80 karakter.",
  team_invalid_identifier: "Masukkan username atau alamat email yang valid.",
  team_invite_recipient_not_found: "Tidak ada akun dengan username tersebut.",
  team_competition_not_found: "Kompetisi tidak ditemukan.",
  team_competition_not_published: "Kompetisi tidak tersedia untuk pendaftaran.",
  team_competition_mode_not_allowed: "Kompetisi ini hanya menerima pendaftaran individu.",
  team_registration_not_allowed: "Kompetisi ini hanya menerima pendaftaran individu.",
  team_competition_registration_closed: "Batas waktu pendaftaran telah terlewat.",
  registration_window_closed: "Batas waktu pendaftaran telah terlewat.",
  registration_not_yet_open: "Pendaftaran kompetisi ini belum dibuka.",
  team_not_found: "Tim ini sudah tidak ada. Muat ulang halaman.",
  team_not_captain: "Hanya kapten tim yang dapat melakukan tindakan ini.",
  team_not_forming: "Tim ini sudah tidak dalam tahap pembentukan. Muat ulang halaman.",
  team_name_taken: "Nama tim ini sudah dipakai di kompetisi ini. Pilih nama lain.",
  team_candidate_already_member: "Anda sudah tergabung dalam tim untuk kompetisi ini.",
  team_at_capacity: "Tim telah mencapai kapasitas maksimum.",
  team_invite_already_pending: "Undangan untuk orang ini masih menunggu jawaban.",
  team_invite_not_found: "Undangan tidak ditemukan. Muat ulang halaman.",
  team_invite_not_actionable: "Undangan ini sudah tidak berlaku.",
  team_membership_not_found: "Anggota ini sudah tidak ada di tim. Muat ulang halaman.",
  team_member_not_in_team: "Anggota ini sudah tidak ada di tim. Muat ulang halaman.",
  team_captain_cannot_leave:
    "Kapten tidak dapat meninggalkan tim. Bubarkan tim jika ingin berhenti.",
  team_forbidden: "Hanya kapten atau anggota itu sendiri yang dapat mengeluarkan anggota.",
  team_member_already_registered: "Satu atau lebih anggota tim sudah terdaftar di kompetisi ini.",
  team_state_conflict: "Status tim baru saja berubah. Muat ulang halaman lalu coba lagi.",
  team_not_submitted: "Tim ini belum didaftarkan, jadi tidak ada pendaftaran yang bisa dibatalkan.",
  team_register_again_closed_by_payment_proof: TEAM_REGISTER_AGAIN_CLOSED_MESSAGE,
  // The organiser cannot take payment right now: unverified, no published account, or no fee rule
  // in force. All three collapse to one code server-side so none of them leaks, and none of them is
  // the candidate's to fix. A generic "coba lagi" message would invite a retry that cannot succeed.
  registration_payment_unavailable:
    "Penyelenggara kompetisi ini belum dapat menerima pembayaran, jadi pendaftaran berbayar belum bisa diproses. Hubungi penyelenggara.",
};

// On an invitation the already-member refusal is about the invitee, not the caller.
const TEAM_INVITE_ERROR_COPY: SurfaceCopy = {
  ...TEAM_ERROR_COPY,
  team_candidate_already_member: "Orang ini sudah ada di tim.",
};

const CREATE_TEAM_FALLBACK = "Gagal membuat tim. Coba lagi.";
const CANCEL_TEAM_REGISTRATION_FALLBACK = "Gagal membatalkan pendaftaran tim. Coba lagi.";

// A size limit the competition does not set has no number to name, so that refusal shows the
// action's fallback.
const teamSizeErrorCopy = (
  minTeamSize: number | null,
  maxTeamSize: number | null,
  isFreeCompetition: boolean,
): SurfaceCopy => {
  const copy: SurfaceCopy = {};
  if (minTeamSize !== null) {
    copy.team_size_insufficient = isFreeCompetition
      ? `Tim membutuhkan minimal ${minTeamSize} orang, dihitung dari anggota dan undangan yang masih berlaku.`
      : `Tim membutuhkan minimal ${minTeamSize} anggota aktif.`;
  }
  if (maxTeamSize !== null) {
    copy.team_size_exceeded = isFreeCompetition
      ? `Tim melebihi maksimum ${maxTeamSize} orang, dihitung dari anggota dan undangan yang masih berlaku.`
      : `Tim melebihi maksimum ${maxTeamSize} anggota aktif.`;
  }
  return copy;
};

const TEAM_STATUS_LABELS: Record<string, string> = {
  forming: "Pembentukan",
  submitted: "Terdaftar",
  cancelled: "Dibatalkan",
};

const getTeamStatusLabel = (status: string): string =>
  TEAM_STATUS_LABELS[status] ?? formatDisplayToken(status);

const readRefusalMessage = async (
  res: Response,
  surfaceCopy: SurfaceCopy,
  fallback: string,
): Promise<string> => {
  const code = await readErrorCode(res);
  return errorMessageFor(code, surfaceCopy, fallback);
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
        const message = await readRefusalMessage(res, TEAM_ERROR_COPY, CREATE_TEAM_FALLBACK);
        addToast({ type: "error", message });
        return;
      }
      router.refresh();
      setName("");
    } catch {
      addToast({ type: "error", message: NETWORK_ERROR_MESSAGE });
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
  // A free team registers on joined members plus open invites, a paid team on joined members only.
  const registrationSeatCount = props.isFreeCompetition
    ? memberCount + props.openInvitationCount
    : memberCount;
  const sizeBelowMin = props.minTeamSize !== null && registrationSeatCount < props.minTeamSize;
  const sizeAboveMax = props.maxTeamSize !== null && registrationSeatCount > props.maxTeamSize;
  const submitDisabledReason = (() => {
    if (status !== "forming") return `Tim sudah berstatus '${getTeamStatusLabel(status)}'`;
    if (!props.registrationOpen) return "Pendaftaran kompetisi belum dibuka atau sudah ditutup";
    if (sizeBelowMin) {
      return props.isFreeCompetition
        ? `Tim membutuhkan minimal ${props.minTeamSize} orang, dihitung dari anggota dan undangan yang masih berlaku`
        : `Tim membutuhkan minimal ${props.minTeamSize} anggota aktif`;
    }
    if (sizeAboveMax) {
      return props.isFreeCompetition
        ? `Tim melebihi maksimum ${props.maxTeamSize} orang, dihitung dari anggota dan undangan yang masih berlaku`
        : `Tim melebihi maksimum ${props.maxTeamSize} anggota aktif`;
    }
    return null;
  })();

  const isRegisteredFreeTeamOpen =
    status === "submitted" && props.isFreeCompetition && props.registrationOpen;
  const takesInviteChanges = status === "forming" || isRegisteredFreeTeamOpen;
  // A team that cannot register again gains nothing from a new member, so the form is withheld.
  // The server still takes an invite to such a team and the invitee's acceptance.
  const offersInviteForm = takesInviteChanges && !props.registerAgainClosedByPaymentProof;

  useEffect(() => {
    if (atCapacity) {
      addToast({ type: "warning", message: "Tim telah mencapai kapasitas maksimum." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atCapacity]);

  useEffect(() => {
    if (
      isCaptain &&
      submitDisabledReason &&
      status === "forming" &&
      !props.registerAgainClosedByPaymentProof
    ) {
      addToast({ type: "warning", message: submitDisabledReason });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaptain, submitDisabledReason, status, props.registerAgainClosedByPaymentProof]);

  useEffect(() => {
    if (!isCaptain && ownMembership) {
      addToast({
        type: "info",
        message: "Hanya kapten yang dapat mendaftarkan atau membubarkan tim.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaptain, ownMembership]);

  const executeAction = async (
    actionKey: string,
    label: string,
    url: string,
    init: RequestInit,
    surfaceCopy: SurfaceCopy,
  ) => {
    setPendingAction(actionKey);
    try {
      const res = await sessionFetch(props.expectedUserId, url, init);
      if (!res.ok) {
        const code = await readErrorCode(res);
        const message = errorMessageFor(code, surfaceCopy, `Gagal ${label}.`);
        addToast({ type: "error", message });
        // This refusal holds for as long as the team exists, so the page is read again and the
        // register control gives way to the note.
        if (code === "team_register_again_closed_by_payment_proof") {
          router.refresh();
        }
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
    await executeAction(
      "invite",
      "mengirim undangan",
      `/api/v1/teams/${team.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitedIdentifier: inviteIdentifier }),
      },
      TEAM_INVITE_ERROR_COPY,
    );
    setInviteIdentifier("");
  };

  const onCancelInvite = (tokenHash: string) =>
    executeAction(
      `cancel-invite:${tokenHash}`,
      "membatalkan undangan",
      `/api/v1/teams/${team.id}/invitations/${tokenHash}`,
      { method: "DELETE" },
      TEAM_ERROR_COPY,
    );

  const onRemoveMember = (membershipId: string) =>
    executeAction(
      `remove-member:${membershipId}`,
      "menghapus anggota",
      `/api/v1/teams/${team.id}/memberships/${membershipId}`,
      { method: "DELETE" },
      TEAM_ERROR_COPY,
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
            void executeAction(
              "disband",
              "membubarkan tim",
              `/api/v1/teams/${team.id}`,
              { method: "DELETE" },
              TEAM_ERROR_COPY,
            );
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
              TEAM_ERROR_COPY,
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
      {
        ...TEAM_ERROR_COPY,
        ...teamSizeErrorCopy(props.minTeamSize, props.maxTeamSize, props.isFreeCompetition),
      },
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
        const message = await readRefusalMessage(
          res,
          { ...TEAM_ERROR_COPY, ...TEAM_CANCEL_MESSAGE },
          CANCEL_TEAM_REGISTRATION_FALLBACK,
        );
        addToast({ type: "error", message });
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

  // A team that cannot register again cannot be completed, so leaving it is not warned against.
  const warnsOnLeavingIncompleteTeam =
    sizeBelowMin && status === "forming" && !props.registerAgainClosedByPaymentProof;

  // Warn on hard navigation (URL change, tab close, refresh) when team is incomplete.
  useEffect(() => {
    if (!warnsOnLeavingIncompleteTeam) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [warnsOnLeavingIncompleteTeam]);

  // Offer to save the competition as a bookmark when backing out with an incomplete team.
  const handleBackOut = () => {
    if (!warnsOnLeavingIncompleteTeam) {
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

      {isRegisteredFreeTeamOpen && props.registrationClosesAt !== null ? (
        <Feedback tone="info">
          Tim sudah terdaftar. Undangan yang belum dijawab berlaku sampai pendaftaran ditutup pada{" "}
          <LocalDate value={props.registrationClosesAt} format="longDateTime" />. Siapa pun yang
          menerima sebelum itu langsung terdaftar bersama tim.
          {isCaptain
            ? " Sampai saat itu, Anda masih dapat membatalkan undangan dan mengundang orang lain."
            : null}
        </Feedback>
      ) : null}

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
                {isCaptain && takesInviteChanges && (
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

      {isCaptain && offersInviteForm && (
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
          {status === "forming" &&
            !props.registrationWithheld &&
            !props.registerAgainClosedByPaymentProof && (
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

      {/* Stands where the register control would have been, and only for the captain, like the cancel
          note below. */}
      {isCaptain && status === "forming" && props.registerAgainClosedByPaymentProof && (
        <Feedback tone="neutral">{TEAM_REGISTER_AGAIN_CLOSED_MESSAGE}</Feedback>
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
