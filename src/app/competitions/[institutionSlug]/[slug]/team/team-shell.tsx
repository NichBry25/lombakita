"use client";

import { useCallback, useState } from "react";

type SerializedTeamSnapshot = {
  team: {
    id: string;
    competitionId: string;
    name: string;
    captainId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  roster: Array<{
    membershipId: string;
    userId: string;
    role: string;
    status: string;
    joinedAt: string;
    displayName: string | null;
    email: string;
  }>;
  pendingInvitations: Array<{
    id: string;
    invitedEmail: string;
    status: string;
    expiresAt: string;
    createdAt: string;
  }>;
};

type Props = {
  competitionId: string;
  competitionMaxTeamSize: number | null;
  initialTeam: SerializedTeamSnapshot | null;
  currentUserId: string;
};

type ApiError = { code: string; message: string };

const readError = async (res: Response): Promise<ApiError> => {
  try {
    const body = await res.json();
    if (body?.error?.code) {
      return { code: body.error.code, message: body.error.message ?? "" };
    }
  } catch {
    /* ignore */
  }
  return { code: `http_${res.status}`, message: `Request failed with status ${res.status}` };
};

export function TeamShell(props: Props) {
  const [snapshot, setSnapshot] = useState<SerializedTeamSnapshot | null>(props.initialTeam);
  const [error, setError] = useState<ApiError | null>(null);

  const refetch = useCallback(async () => {
    if (!snapshot) return;
    const res = await fetch(`/api/v1/teams/${snapshot.team.id}`);
    if (res.ok) {
      const body = await res.json();
      setSnapshot(body);
    }
  }, [snapshot]);

  if (!snapshot) {
    return (
      <CreateTeamForm
        competitionId={props.competitionId}
        onCreated={(s) => {
          setSnapshot(s);
          setError(null);
        }}
        setError={setError}
        error={error}
      />
    );
  }

  return (
    <TeamRosterShell
      snapshot={snapshot}
      competitionMaxTeamSize={props.competitionMaxTeamSize}
      currentUserId={props.currentUserId}
      onRefresh={refetch}
      onError={setError}
      error={error}
      onDisbanded={() => {
        setSnapshot(null);
        setError(null);
      }}
    />
  );
}

function CreateTeamForm(props: {
  competitionId: string;
  onCreated: (s: SerializedTeamSnapshot) => void;
  setError: (e: ApiError | null) => void;
  error: ApiError | null;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    props.setError(null);
    try {
      const res = await fetch(`/api/v1/competitions/${props.competitionId}/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        props.setError(await readError(res));
        return;
      }
      // Re-fetch the full snapshot so the roster shows.
      const snapshotRes = await fetch(`/api/v1/competitions/${props.competitionId}/teams`);
      const body = await snapshotRes.json();
      if (body?.team) {
        props.onCreated(body.team);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18 }}>Buat Tim</h2>
      <p style={{ fontSize: 13, color: "#555", marginBottom: 12 }}>
        Anda akan menjadi kapten tim setelah membuatnya.
      </p>
      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ fontSize: 13 }}>Nama Tim</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 4, fontSize: 14 }}
          required
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px 20px",
            background: loading ? "#888" : "#355795",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 14,
            alignSelf: "flex-start",
            marginTop: 4,
          }}
        >
          {loading ? "Membuat…" : "Buat Tim"}
        </button>
      </form>
      {props.error && <ErrorBox error={props.error} />}
    </section>
  );
}

function TeamRosterShell(props: {
  snapshot: SerializedTeamSnapshot;
  competitionMaxTeamSize: number | null;
  currentUserId: string;
  onRefresh: () => Promise<void>;
  onError: (e: ApiError | null) => void;
  error: ApiError | null;
  onDisbanded: () => void;
}) {
  const { snapshot } = props;
  const isCaptain = snapshot.team.captainId === props.currentUserId;
  const seatsUsed = snapshot.roster.length + snapshot.pendingInvitations.length;
  const atCapacity =
    props.competitionMaxTeamSize !== null && seatsUsed >= props.competitionMaxTeamSize;

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteBusy(true);
    props.onError(null);
    try {
      const res = await fetch(`/api/v1/teams/${snapshot.team.id}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitedEmail: inviteEmail }),
      });
      if (!res.ok) {
        props.onError(await readError(res));
        return;
      }
      setInviteEmail("");
      await props.onRefresh();
    } finally {
      setInviteBusy(false);
    }
  };

  const onDisband = async () => {
    if (!window.confirm("Bubarkan tim? Tindakan ini tidak dapat dibatalkan.")) return;
    setActionBusy(true);
    props.onError(null);
    try {
      const res = await fetch(`/api/v1/teams/${snapshot.team.id}`, { method: "DELETE" });
      if (!res.ok) {
        props.onError(await readError(res));
        return;
      }
      props.onDisbanded();
    } finally {
      setActionBusy(false);
    }
  };

  const onRemoveMember = async (membershipId: string) => {
    setActionBusy(true);
    props.onError(null);
    try {
      const res = await fetch(
        `/api/v1/teams/${snapshot.team.id}/memberships/${membershipId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        props.onError(await readError(res));
        return;
      }
      await props.onRefresh();
    } finally {
      setActionBusy(false);
    }
  };

  const onCancelInvite = async (invitationId: string) => {
    setActionBusy(true);
    props.onError(null);
    try {
      const res = await fetch(
        `/api/v1/teams/${snapshot.team.id}/invitations/${invitationId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        props.onError(await readError(res));
        return;
      }
      await props.onRefresh();
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18 }}>
        {snapshot.team.name}{" "}
        <span style={{ fontSize: 13, fontWeight: 400, color: "#555" }}>
          ({snapshot.team.status})
        </span>
      </h2>
      <p style={{ fontSize: 13, color: "#555" }}>
        {seatsUsed}
        {props.competitionMaxTeamSize !== null ? ` / ${props.competitionMaxTeamSize}` : ""} kursi
        terpakai (kapten + anggota aktif + undangan tertunda)
      </p>

      <h3 style={{ fontSize: 15, marginTop: 16 }}>Roster</h3>
      <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
        {snapshot.roster.map((r) => (
          <li
            key={r.membershipId}
            style={{
              padding: 8,
              borderBottom: "1px solid #eee",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {r.displayName ?? r.email}{" "}
              <span style={{ fontSize: 12, color: "#888" }}>({r.role})</span>
            </span>
            {isCaptain && r.role !== "captain" && (
              <button
                onClick={() => onRemoveMember(r.membershipId)}
                disabled={actionBusy}
                style={{
                  background: "transparent",
                  border: "1px solid #c00",
                  color: "#c00",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 12,
                  cursor: actionBusy ? "not-allowed" : "pointer",
                }}
              >
                Hapus
              </button>
            )}
          </li>
        ))}
      </ul>

      {snapshot.pendingInvitations.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, marginTop: 16 }}>Undangan Tertunda</h3>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
            {snapshot.pendingInvitations.map((p) => (
              <li
                key={p.id}
                style={{
                  padding: 8,
                  borderBottom: "1px solid #eee",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>{p.invitedEmail}</span>
                {isCaptain && (
                  <button
                    onClick={() => onCancelInvite(p.id)}
                    disabled={actionBusy}
                    style={{
                      background: "transparent",
                      border: "1px solid #888",
                      color: "#555",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                      cursor: actionBusy ? "not-allowed" : "pointer",
                    }}
                  >
                    Batalkan
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {isCaptain && snapshot.team.status === "forming" && (
        <>
          <h3 style={{ fontSize: 15, marginTop: 24 }}>Undang Anggota</h3>
          <form onSubmit={onInvite} style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@example.com"
              required
              disabled={inviteBusy || atCapacity}
              style={{
                flex: 1,
                padding: 8,
                border: "1px solid #ccc",
                borderRadius: 4,
                fontSize: 14,
              }}
            />
            <button
              type="submit"
              disabled={inviteBusy || atCapacity}
              style={{
                padding: "8px 16px",
                background: inviteBusy || atCapacity ? "#888" : "#355795",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: inviteBusy || atCapacity ? "not-allowed" : "pointer",
                fontSize: 14,
              }}
            >
              {inviteBusy ? "Mengirim…" : "Undang"}
            </button>
          </form>
          {atCapacity && (
            <p style={{ fontSize: 12, color: "#a23", marginTop: 4 }}>
              Tim telah mencapai kapasitas maksimum.
            </p>
          )}

          <div style={{ marginTop: 24 }}>
            <button
              onClick={onDisband}
              disabled={actionBusy}
              style={{
                background: "transparent",
                border: "1px solid #c00",
                color: "#c00",
                padding: "6px 14px",
                borderRadius: 4,
                fontSize: 13,
                cursor: actionBusy ? "not-allowed" : "pointer",
              }}
            >
              Bubarkan Tim
            </button>
          </div>
        </>
      )}

      {props.error && <ErrorBox error={props.error} />}
    </section>
  );
}

function ErrorBox(props: { error: ApiError }) {
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
      <strong>{props.error.code}</strong>: {props.error.message}
    </div>
  );
}
