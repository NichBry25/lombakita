"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { useModal, useToast } from "@/components/ui/primitives";

type EligibilityStatus = "eligible" | "ineligible_age" | "ineligible_enrollment" | "incomplete";

type Member = {
  membershipId: string;
  userId: string;
  role: "captain" | "member" | string;
  displayName: string | null;
  email: string;
  eligibility: {
    status: EligibilityStatus;
    reasons: string[];
  };
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

const ELIGIBILITY_LABEL: Record<EligibilityStatus, string> = {
  eligible: "Memenuhi syarat",
  ineligible_age: "Usia tidak memenuhi",
  ineligible_enrollment: "Status studi tidak memenuhi",
  incomplete: "Profil belum lengkap",
};

const eligibilityBadgeStyle = (status: EligibilityStatus): React.CSSProperties => ({
  display: "inline-block",
  marginLeft: 8,
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: 11,
  background: status === "eligible" ? "#dfd" : "#fee",
  color: status === "eligible" ? "#060" : "#a00",
  border: `1px solid ${status === "eligible" ? "#0a0" : "#c00"}`,
});

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
    <section
      style={{
        marginTop: 32,
        padding: 20,
        border: "1px solid #e5e5e5",
        borderRadius: 8,
        background: "#fbfbfd",
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>Tim</h2>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
        {props.competitionMode === "both"
          ? "Anda dapat mendaftar sebagai tim atau secara individu (di tombol Daftar di atas)."
          : "Kompetisi ini wajib didaftarkan sebagai tim."}
      </p>

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
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
        setError(await handleError(res));
        return;
      }
      router.refresh();
      setName("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: 15, marginBottom: 8 }}>Buat tim</h3>
      <p style={{ fontSize: 13, color: "#555", marginBottom: 12 }}>
        Anda akan menjadi kapten setelah membuat tim.
      </p>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama tim"
          required
          style={{
            flex: "1 1 240px",
            padding: 8,
            border: "1px solid #ccc",
            borderRadius: 4,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: "8px 16px",
            background: busy ? "#888" : "#355795",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {busy ? "Membuat…" : "Buat tim"}
        </button>
      </form>
      {error && <ErrorAlert error={error} />}
    </div>
  );
}

function TeamRoster(props: Props & { team: TeamSnapshot }) {
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();
  const { team } = props;
  const isCaptain = team.captainId === props.expectedUserId;
  const status = team.status;

  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  // Step 6.5e — a username OR an email; resolved server-side.
  const [inviteIdentifier, setInviteIdentifier] = useState("");

  const seatsUsed = props.initialMembers.length + props.initialPendingInvitations.length;
  const atCapacity = props.maxTeamSize !== null && seatsUsed >= props.maxTeamSize;

  // Submission gate hints (UI-side mirror of server checks; server is authoritative).
  const ineligibleMembers = props.initialMembers.filter((m) => m.eligibility.status !== "eligible");
  const memberCount = props.initialMembers.length;
  const sizeBelowMin = props.minTeamSize !== null && memberCount < props.minTeamSize;
  const sizeAboveMax = props.maxTeamSize !== null && memberCount > props.maxTeamSize;
  const submitDisabledReason = (() => {
    if (status !== "forming") return `Tim sudah berstatus '${status}'`;
    if (!props.registrationOpen) return "Pendaftaran kompetisi belum dibuka atau sudah ditutup";
    if (sizeBelowMin) return `Tim membutuhkan minimal ${props.minTeamSize} anggota aktif`;
    if (sizeAboveMax) return `Tim melebihi maksimum ${props.maxTeamSize} anggota aktif`;
    if (ineligibleMembers.length > 0)
      return `${ineligibleMembers.length} anggota belum memenuhi syarat`;
    return null;
  })();

  const action = async (
    label: string,
    url: string,
    init: RequestInit,
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sessionFetch(props.expectedUserId, url, init);
      if (!res.ok) {
        setError(await handleError(res));
        return;
      }
      router.refresh();
    } catch {
      setError({ code: "network_error", message: `Gagal ${label}.` });
    } finally {
      setBusy(false);
    }
  };

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    await action(
      "mengirim undangan",
      `/api/v1/teams/${team.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitedIdentifier: inviteIdentifier }),
      },
    );
    setInviteIdentifier("");
  };

  const onCancelInvite = (tokenHash: string) =>
    action(
      "membatalkan undangan",
      `/api/v1/teams/${team.id}/invitations/${tokenHash}`,
      { method: "DELETE" },
    );

  const onRemoveMember = (membershipId: string) =>
    action(
      "menghapus anggota",
      `/api/v1/teams/${team.id}/memberships/${membershipId}`,
      { method: "DELETE" },
    );

  const onDisband = () =>
    action(
      "membubarkan tim",
      `/api/v1/teams/${team.id}`,
      { method: "DELETE" },
      "Bubarkan tim? Tindakan ini tidak dapat dibatalkan.",
    );

  const onLeave = (membershipId: string) =>
    action(
      "meninggalkan tim",
      `/api/v1/teams/${team.id}/memberships/${membershipId}`,
      { method: "DELETE" },
      "Tinggalkan tim?",
    );

  const onSubmitTeam = () =>
    action(
      "mendaftarkan tim",
      `/api/v1/competitions/${props.competitionId}/teams/${team.id}/registrations`,
      { method: "POST" },
    );

  const onCancelSubmission = () =>
    action(
      "membatalkan pendaftaran tim",
      `/api/v1/competitions/${props.competitionId}/teams/${team.id}/registrations`,
      { method: "DELETE" },
      "Batalkan pendaftaran tim? Tim akan kembali ke status 'forming'.",
    );

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
          label: "Simpan & Keluar",
          variant: "primary",
          autoClose: true,
          onClick: () => { void saveAndBack(); },
        },
        {
          label: "Keluar tanpa menyimpan",
          variant: "secondary",
          autoClose: true,
          onClick: () => { router.back(); },
        },
      ],
    });
  };

  const ownMembership = props.initialMembers.find((m) => m.userId === props.expectedUserId);

  return (
    <div>
      <p style={{ fontSize: 14, marginBottom: 4 }}>
        <strong>{team.name}</strong>
        <span
          style={{
            marginLeft: 8,
            padding: "2px 8px",
            borderRadius: 4,
            background: statusBackground(status),
            border: "1px solid #888",
            fontSize: 12,
          }}
        >
          {status}
        </span>
      </p>
      <p style={{ fontSize: 12, color: "#666" }}>
        {seatsUsed}
        {props.maxTeamSize !== null ? ` / ${props.maxTeamSize}` : ""} kursi terpakai
        {props.minTeamSize !== null || props.maxTeamSize !== null
          ? ` (rentang: ${props.minTeamSize ?? "—"} – ${props.maxTeamSize ?? "—"})`
          : ""}
      </p>

      <h3 style={{ fontSize: 14, marginTop: 16, marginBottom: 4 }}>Anggota</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {props.initialMembers.map((m) => (
          <li
            key={m.membershipId}
            style={{
              padding: 8,
              borderBottom: "1px solid #eee",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ flex: "1 1 200px" }}>
              {m.displayName ?? m.email}{" "}
              <span style={{ fontSize: 11, color: "#888" }}>({m.role})</span>
              <span style={eligibilityBadgeStyle(m.eligibility.status)}>
                {ELIGIBILITY_LABEL[m.eligibility.status]}
              </span>
              {m.eligibility.status !== "eligible" && m.eligibility.reasons.length > 0 && (
                <span style={{ display: "block", fontSize: 11, color: "#a00", marginTop: 2 }}>
                  {m.eligibility.reasons.join(", ")}
                </span>
              )}
            </span>
            {isCaptain && m.role !== "captain" && status === "forming" && (
              <button
                onClick={() => onRemoveMember(m.membershipId)}
                disabled={busy}
                style={removeButtonStyle(busy)}
              >
                Hapus
              </button>
            )}
            {!isCaptain && m.userId === props.expectedUserId && status === "forming" && (
              <button
                onClick={() => onLeave(m.membershipId)}
                disabled={busy}
                style={removeButtonStyle(busy)}
              >
                Tinggalkan
              </button>
            )}
          </li>
        ))}
      </ul>

      {props.initialPendingInvitations.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, marginTop: 16, marginBottom: 4 }}>Undangan tertunda</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {props.initialPendingInvitations.map((p) => (
              <li
                key={p.id}
                style={{
                  padding: 8,
                  borderBottom: "1px solid #eee",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span>{p.invitedEmail}</span>
                {isCaptain && status === "forming" && (
                  <button
                    onClick={() => onCancelInvite(p.tokenHash)}
                    disabled={busy}
                    style={removeButtonStyle(busy)}
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
          <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 4 }}>Undang anggota</h3>
          <form onSubmit={onInvite} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              value={inviteIdentifier}
              onChange={(e) => setInviteIdentifier(e.target.value)}
              placeholder="Username atau email"
              required
              disabled={busy || atCapacity}
              style={{
                flex: "1 1 240px",
                padding: 8,
                border: "1px solid #ccc",
                borderRadius: 4,
                fontSize: 14,
              }}
            />
            <button
              type="submit"
              disabled={busy || atCapacity}
              style={{
                padding: "8px 16px",
                background: busy || atCapacity ? "#888" : "#355795",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: busy || atCapacity ? "not-allowed" : "pointer",
                fontSize: 14,
              }}
            >
              Undang
            </button>
          </form>
          {atCapacity && (
            <p style={{ fontSize: 12, color: "#a23", marginTop: 4 }}>
              Tim telah mencapai kapasitas maksimum.
            </p>
          )}
        </>
      )}

      {/* Submission + cancellation controls — captain only. */}
      {isCaptain && (
        <div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {status === "forming" && (
            <button
              onClick={onSubmitTeam}
              disabled={busy || submitDisabledReason !== null}
              title={submitDisabledReason ?? ""}
              style={{
                padding: "10px 18px",
                background: busy || submitDisabledReason !== null ? "#888" : "#355795",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: busy || submitDisabledReason !== null ? "not-allowed" : "pointer",
                fontSize: 14,
              }}
            >
              {busy ? "Memproses…" : "Daftarkan Tim"}
            </button>
          )}
          {status === "submitted" && (
            <button
              onClick={onCancelSubmission}
              disabled={busy}
              style={{
                padding: "10px 18px",
                background: "transparent",
                color: "#c00",
                border: "1px solid #c00",
                borderRadius: 4,
                cursor: busy ? "not-allowed" : "pointer",
                fontSize: 14,
              }}
            >
              Batalkan Pendaftaran Tim
            </button>
          )}
          {status === "forming" && (
            <button
              onClick={onDisband}
              disabled={busy}
              style={{
                padding: "10px 18px",
                background: "transparent",
                color: "#c00",
                border: "1px solid #c00",
                borderRadius: 4,
                cursor: busy ? "not-allowed" : "pointer",
                fontSize: 14,
              }}
            >
              Bubarkan Tim
            </button>
          )}
        </div>
      )}

      {isCaptain && submitDisabledReason && status === "forming" && (
        <p style={{ fontSize: 12, color: "#a23", marginTop: 8 }}>{submitDisabledReason}</p>
      )}

      {/* F16: back-out with save-progress option when team is incomplete */}
      {sizeBelowMin && status === "forming" && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={handleBackOut}
            style={{
              background: "none",
              border: "none",
              color: "#355795",
              cursor: "pointer",
              fontSize: 13,
              padding: 0,
            }}
          >
            ← Kembali ke detail kompetisi
          </button>
        </div>
      )}

      {!isCaptain && ownMembership && (
        <p style={{ marginTop: 16, fontSize: 13, color: "#555" }}>
          Hanya kapten ({team.captainId.slice(0, 8)}…) yang dapat mendaftarkan atau membubarkan
          tim.
        </p>
      )}

      {error && <ErrorAlert error={error} />}
    </div>
  );
}

function statusBackground(status: string): string {
  if (status === "submitted") return "#def";
  if (status === "cancelled") return "#eee";
  return "#fff7d6";
}

function removeButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid #c00",
    color: "#c00",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function ErrorAlert({ error }: { error: ApiError }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 12,
        padding: 8,
        background: "#fee",
        border: "1px solid #c00",
        borderRadius: 4,
        color: "#a00",
        fontSize: 13,
      }}
    >
      <strong>{error.code}</strong>: {error.message}
      {error.details && Object.keys(error.details).length > 0 && (
        <pre style={{ marginTop: 4, fontSize: 11, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(error.details, null, 2)}
        </pre>
      )}
    </div>
  );
}
