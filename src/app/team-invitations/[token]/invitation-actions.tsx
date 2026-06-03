"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  token: string;
  isAuthenticated: boolean;
  sessionEmail: string | null;
  invitedEmail: string;
  sessionRole: string | null;
  expiresAtIso: string;
};

export function InvitationActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const callbackUrl = `/team-invitations/${encodeURIComponent(props.token)}`;
  const expired = new Date(props.expiresAtIso).getTime() <= Date.now();

  if (expired) {
    return (
      <p style={{ marginTop: 16, color: "#a23" }}>Undangan ini sudah kedaluwarsa.</p>
    );
  }

  const onAccept = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/v1/team-invitations/${props.token}/accept`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? `Gagal menerima undangan (${res.status})`);
        return;
      }
      const body = await res.json();
      setSuccess("Anda telah bergabung dengan tim.");
      if (body?.teamId) {
        router.push(`/team-invitations/${props.token}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onDecline = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/v1/team-invitations/${props.token}/decline`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? `Gagal menolak undangan (${res.status})`);
        return;
      }
      setSuccess("Undangan ditolak.");
    } finally {
      setBusy(false);
    }
  };

  if (!props.isAuthenticated) {
    return (
      <div style={{ marginTop: 16 }}>
        <p>
          Silakan masuk dengan akun yang sesuai untuk menerima undangan ini.
        </p>
        <a
          href={`/auth/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
          style={{
            display: "inline-block",
            marginTop: 8,
            padding: "8px 16px",
            background: "#355795",
            color: "#fff",
            borderRadius: 4,
            textDecoration: "none",
            fontSize: 14,
          }}
        >
          Masuk
        </a>
        <p style={{ marginTop: 12, fontSize: 13, color: "#555" }}>
          Anda juga dapat menolak undangan tanpa masuk:
        </p>
        <button
          onClick={onDecline}
          disabled={busy}
          style={{
            marginTop: 4,
            background: "transparent",
            border: "1px solid #888",
            padding: "6px 12px",
            borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          Tolak Undangan
        </button>
        {error && <ErrorMessage message={error} />}
        {success && <SuccessMessage message={success} />}
      </div>
    );
  }

  if (props.sessionRole !== "candidate") {
    return (
      <p style={{ marginTop: 16, color: "#a23" }}>
        Akun Anda bukan akun kandidat. Hanya akun kandidat yang dapat menerima undangan tim.
      </p>
    );
  }

  if (props.sessionEmail !== null && props.sessionEmail !== props.invitedEmail) {
    // Privacy: do NOT reveal the invited email here. The recipient already knows the address
    // their invite landed at (it's the inbox they opened the link from); a logged-in attacker
    // who guessed a token must not learn the target identity.
    return (
      <div style={{ marginTop: 16 }}>
        <p style={{ color: "#a23" }}>
          Undangan ini ditujukan untuk alamat email lain. Anda saat ini masuk sebagai{" "}
          <strong>{props.sessionEmail}</strong>.
        </p>
        <p style={{ marginTop: 8, fontSize: 13, color: "#555" }}>
          Keluar dan masuk dengan akun yang sesuai untuk menerima undangan.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
      <button
        onClick={onAccept}
        disabled={busy}
        style={{
          padding: "10px 20px",
          background: busy ? "#888" : "#355795",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: busy ? "not-allowed" : "pointer",
          fontSize: 14,
        }}
      >
        {busy ? "Memproses…" : "Terima"}
      </button>
      <button
        onClick={onDecline}
        disabled={busy}
        style={{
          padding: "10px 20px",
          background: "transparent",
          border: "1px solid #888",
          borderRadius: 4,
          cursor: busy ? "not-allowed" : "pointer",
          fontSize: 14,
        }}
      >
        Tolak
      </button>
      {error && <ErrorMessage message={error} />}
      {success && <SuccessMessage message={success} />}
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p role="alert" style={{ marginTop: 8, color: "#a00", fontSize: 13 }}>
      {message}
    </p>
  );
}

function SuccessMessage({ message }: { message: string }) {
  return (
    <p role="status" style={{ marginTop: 8, color: "#080", fontSize: 13 }}>
      {message}
    </p>
  );
}
