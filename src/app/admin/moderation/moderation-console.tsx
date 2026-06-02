"use client";

import { useCallback, useEffect, useState } from "react";

// Step 6.2 — minimal proof moderation console. No design polish; every error and outcome is
// rendered visibly so the flow is manually verifiable. Inline styles only.

type UserResult = {
  id: string;
  email: string;
  name: string | null;
  appRole: string;
  candidateVerifiedAt: string | null;
  recruiterVerifiedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
};

type InstitutionResult = {
  id: string;
  name: string;
  slug: string;
  verificationStatus: string;
  verifiedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  createdAt: string;
};

type NoteItem = {
  id: string;
  note: string;
  createdById: string;
  createdByName: string | null;
  createdAt: string;
};

const box: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 16,
  marginBottom: 24,
};
const label: React.CSSProperties = { fontSize: 12, color: "#555", marginRight: 6 };
const input: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid #ccc",
  fontSize: 13,
};
const btn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "none",
  background: "#355795",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
};
const errStyle: React.CSSProperties = { color: "#721c24", fontSize: 13 };
const okStyle: React.CSSProperties = { color: "#155724", fontSize: 13 };

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error?.code ? `${data.error.code} — ${data.error.message ?? ""}` : `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

function NotesPanel({ target }: { target: { targetUserId?: string; targetInstitutionId?: string } }) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [noteInput, setNoteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = target.targetUserId
    ? `targetUserId=${encodeURIComponent(target.targetUserId)}`
    : `targetInstitutionId=${encodeURIComponent(target.targetInstitutionId ?? "")}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/platform-ops/notes?${query}`);
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = await res.json();
      setNotes(data.notes ?? []);
    } catch {
      setError("Kesalahan jaringan saat memuat catatan.");
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const addNote = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform-ops/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, note: noteInput }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNoteInput("");
      await load();
    } catch {
      setError("Kesalahan jaringan saat menambah catatan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12, borderTop: "1px dashed #ccc", paddingTop: 10 }}>
      <strong style={{ fontSize: 13 }}>Catatan Internal</strong>
      <div style={{ margin: "8px 0" }}>
        <input
          style={{ ...input, width: 360 }}
          placeholder="Tambah catatan…"
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
        />{" "}
        <button style={btn} disabled={busy} onClick={() => void addNote()}>
          Simpan Catatan
        </button>
      </div>
      {error && <p style={errStyle}>{error}</p>}
      {notes.length === 0 ? (
        <p style={{ color: "#888", fontSize: 12 }}>Belum ada catatan.</p>
      ) : (
        <ul style={{ fontSize: 12, paddingLeft: 18 }}>
          {notes.map((n) => (
            <li key={n.id} style={{ marginBottom: 4 }}>
              {n.note}{" "}
              <span style={{ color: "#999" }}>
                — {n.createdByName ?? n.createdById} · {new Date(n.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionForm({
  buttonLabel,
  onSubmit,
}: {
  buttonLabel: string;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <input
        style={{ ...input, width: 220 }}
        placeholder="Alasan…"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />{" "}
      <button
        style={busy ? { ...btn, opacity: 0.6 } : btn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSubmit(reason);
          } finally {
            setBusy(false);
          }
        }}
      >
        {buttonLabel}
      </button>
    </span>
  );
}

function UserPanel() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<UserResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const lookup = async () => {
    setError(null);
    setActionMsg(null);
    setResult(null);
    try {
      const res = await fetch(`/api/platform-ops/users/lookup?email=${encodeURIComponent(email)}`);
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = await res.json();
      setResult(data.user);
    } catch {
      setError("Kesalahan jaringan.");
    }
  };

  const runAction = async (action: "suspend" | "unsuspend", reason: string) => {
    if (!result) return;
    setError(null);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/platform-ops/users/${result.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setActionMsg(action === "suspend" ? "Pengguna ditangguhkan." : "Penangguhan dicabut.");
      await lookup();
    } catch {
      setError("Kesalahan jaringan.");
    }
  };

  return (
    <section style={box}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Pengguna</h2>
      <div>
        <span style={label}>Email</span>
        <input
          style={{ ...input, width: 260 }}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
        />{" "}
        <button style={btn} onClick={() => void lookup()}>
          Cari
        </button>
      </div>
      {error && <p style={errStyle}>{error}</p>}
      {actionMsg && <p style={okStyle}>{actionMsg}</p>}

      {result && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <div>
            <strong>{result.name ?? "(tanpa nama)"}</strong> · {result.email} · peran:{" "}
            {result.appRole}
          </div>
          <div style={{ color: "#555", marginTop: 4 }}>
            Status:{" "}
            {result.suspendedAt ? (
              <span style={{ color: "#721c24", fontWeight: 600 }}>
                DITANGGUHKAN ({result.suspensionReason ?? "tanpa alasan"})
              </span>
            ) : (
              <span style={{ color: "#155724" }}>Aktif</span>
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            {result.appRole === "platform_ops" || result.appRole === "finance_ops" ? (
              <p style={{ color: "#721c24", fontSize: 13, fontWeight: 600 }}>
                Akun ops internal ({result.appRole}) tidak dapat ditangguhkan.
              </p>
            ) : result.suspendedAt ? (
              <ActionForm
                buttonLabel="Cabut Penangguhan"
                onSubmit={(reason) => runAction("unsuspend", reason)}
              />
            ) : (
              <ActionForm
                buttonLabel="Tangguhkan"
                onSubmit={(reason) => runAction("suspend", reason)}
              />
            )}
          </div>
          <NotesPanel target={{ targetUserId: result.id }} />
        </div>
      )}
    </section>
  );
}

function InstitutionPanel() {
  const [slug, setSlug] = useState("");
  const [result, setResult] = useState<InstitutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const lookup = async () => {
    setError(null);
    setActionMsg(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/platform-ops/institutions/lookup?slug=${encodeURIComponent(slug)}`,
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = await res.json();
      setResult(data.institution);
    } catch {
      setError("Kesalahan jaringan.");
    }
  };

  const runAction = async (action: "suspend" | "reinstate", reason: string) => {
    if (!result) return;
    setError(null);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/platform-ops/institutions/${result.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setActionMsg(action === "suspend" ? "Institusi ditangguhkan." : "Institusi dipulihkan.");
      await lookup();
    } catch {
      setError("Kesalahan jaringan.");
    }
  };

  return (
    <section style={box}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Institusi</h2>
      <div>
        <span style={label}>Slug</span>
        <input
          style={{ ...input, width: 260 }}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="nama-institusi"
        />{" "}
        <button style={btn} onClick={() => void lookup()}>
          Cari
        </button>
      </div>
      {error && <p style={errStyle}>{error}</p>}
      {actionMsg && <p style={okStyle}>{actionMsg}</p>}

      {result && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <div>
            <strong>{result.name}</strong> · {result.slug} · verifikasi:{" "}
            {result.verificationStatus}
          </div>
          <div style={{ color: "#555", marginTop: 4 }}>
            Pemilik: {result.ownerName ?? "—"} ({result.ownerEmail ?? "—"})
          </div>
          <div style={{ color: "#555", marginTop: 4 }}>
            Status operasional:{" "}
            {result.suspendedAt ? (
              <span style={{ color: "#721c24", fontWeight: 600 }}>
                DITANGGUHKAN ({result.suspensionReason ?? "tanpa alasan"})
              </span>
            ) : (
              <span style={{ color: "#155724" }}>Aktif</span>
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            {result.suspendedAt ? (
              <ActionForm
                buttonLabel="Pulihkan"
                onSubmit={(reason) => runAction("reinstate", reason)}
              />
            ) : (
              <ActionForm
                buttonLabel="Tangguhkan"
                onSubmit={(reason) => runAction("suspend", reason)}
              />
            )}
          </div>
          <NotesPanel target={{ targetInstitutionId: result.id }} />
        </div>
      )}
    </section>
  );
}

export function ModerationConsole() {
  return (
    <div>
      <UserPanel />
      <InstitutionPanel />
    </div>
  );
}
