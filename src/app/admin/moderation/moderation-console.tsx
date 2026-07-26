"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { getAppRoleLabel } from "@/lib/access/role-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";

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

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error?.code
      ? `${data.error.code} — ${data.error.message ?? ""}`
      : `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

function NoteRow({ note, onSaved }: { note: NoteItem; onSaved: () => void }) {
  const { addToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(note.note);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/platform-ops/notes/${encodeURIComponent(note.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: editText }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      setEditing(false);
      onSaved();
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan saat menyimpan." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="moderation-note-row">
      {editing ? (
        <div className="moderation-note-edit">
          <input
            className="form-input"
            aria-label="Edit catatan"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
          />
          <Button size="sm" disabled={busy} loading={busy} onClick={() => void save()}>
            Simpan
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(false);
              setEditText(note.note);
            }}
          >
            Batal
          </Button>
        </div>
      ) : (
        <div className="moderation-note-content">
          <span>{note.note}</span>
          <span className="record-meta data-text">
            — {note.createdByName ?? note.createdById} · {new Date(note.createdAt).toLocaleString()}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            aria-label="Edit catatan ini"
          >
            Edit
          </Button>
        </div>
      )}
    </li>
  );
}

function NotesPanel({
  target,
}: {
  target: { targetUserId?: string; targetInstitutionId?: string };
}) {
  const { addToast } = useToast();
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [noteInput, setNoteInput] = useState("");
  const [busy, setBusy] = useState(false);

  const query = target.targetUserId
    ? `targetUserId=${encodeURIComponent(target.targetUserId)}`
    : `targetInstitutionId=${encodeURIComponent(target.targetInstitutionId ?? "")}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/platform-ops/notes?${query}`);
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      const data = await res.json();
      setNotes(data.notes ?? []);
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan saat memuat catatan." });
    }
  }, [query, addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const addNote = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/platform-ops/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, note: noteInput }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      setNoteInput("");
      await load();
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan saat menambah catatan." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="moderation-notes-panel">
      <strong>Catatan internal</strong>
      <div className="moderation-note-form">
        <input
          className="form-input"
          placeholder="Tambah catatan…"
          aria-label="Tambah catatan internal"
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
        />
        <Button size="sm" disabled={busy} loading={busy} onClick={() => void addNote()}>
          Simpan catatan
        </Button>
      </div>
      {notes.length === 0 ? (
        <p className="record-meta">Belum ada catatan.</p>
      ) : (
        <ul className="moderation-note-list">
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} onSaved={() => void load()} />
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
    <div className="moderation-action-form">
      <input
        className="form-input"
        placeholder="Alasan…"
        aria-label={`Alasan — ${buttonLabel}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        variant={buttonLabel === "Tangguhkan" ? "danger" : "primary"}
        size="sm"
        disabled={busy}
        loading={busy}
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
      </Button>
    </div>
  );
}

function UserPanel() {
  const { addToast } = useToast();
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<UserResult | null>(null);
  const [searching, setSearching] = useState(false);

  const lookup = async () => {
    setResult(null);
    setSearching(true);
    try {
      const res = await fetch(`/api/platform-ops/users/lookup?email=${encodeURIComponent(email)}`);
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      const data = await res.json();
      setResult(data.user);
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan." });
    } finally {
      setSearching(false);
    }
  };

  const runAction = async (action: "suspend" | "unsuspend", reason: string) => {
    if (!result) return;
    try {
      const res = await fetch(`/api/platform-ops/users/${result.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      addToast({
        type: "success",
        message: action === "suspend" ? "Pengguna ditangguhkan." : "Penangguhan dicabut.",
      });
      await lookup();
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan." });
    }
  };

  return (
    <section className="content-section moderation-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Pencarian akun</p>
          <h2>Pengguna</h2>
        </div>
      </div>
      <div className="moderation-lookup-form">
        <label htmlFor="user-lookup-email" className="form-label">
          Email
        </label>
        <input
          id="user-lookup-email"
          className="form-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
        />
        <Button size="sm" loading={searching} onClick={() => void lookup()}>
          Cari
        </Button>
      </div>

      {result && (
        <div className="moderation-result">
          <div>
            <strong>{result.name ?? "(tanpa nama)"}</strong> · {result.email} · peran:{" "}
            {getAppRoleLabel(result.appRole)}
          </div>
          <div className="moderation-status-row">
            Status:{" "}
            {result.suspendedAt ? (
              <span className="status-badge" data-status="closed">
                Ditangguhkan ({result.suspensionReason ?? "tanpa alasan"})
              </span>
            ) : (
              <span className="status-badge" data-status="open">
                Aktif
              </span>
            )}
          </div>
          <div>
            {result.appRole === "platform_ops" || result.appRole === "finance_ops" ? (
              <p className="feedback" data-tone="error">
                Akun ops internal ({getAppRoleLabel(result.appRole)}) tidak dapat ditangguhkan.
              </p>
            ) : result.suspendedAt ? (
              <ActionForm
                buttonLabel="Cabut penangguhan"
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
  const { addToast } = useToast();
  const [slug, setSlug] = useState("");
  const [result, setResult] = useState<InstitutionResult | null>(null);
  const [searching, setSearching] = useState(false);

  const lookup = async () => {
    setResult(null);
    setSearching(true);
    try {
      const res = await fetch(
        `/api/platform-ops/institutions/lookup?slug=${encodeURIComponent(slug)}`,
      );
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      const data = await res.json();
      setResult(data.institution);
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan." });
    } finally {
      setSearching(false);
    }
  };

  const runAction = async (action: "suspend" | "reinstate", reason: string) => {
    if (!result) return;
    try {
      const res = await fetch(`/api/platform-ops/institutions/${result.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res) });
        return;
      }
      addToast({
        type: "success",
        message: action === "suspend" ? "Institusi ditangguhkan." : "Institusi dipulihkan.",
      });
      await lookup();
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan." });
    }
  };

  return (
    <section className="content-section moderation-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Pencarian workspace</p>
          <h2>Institusi</h2>
        </div>
      </div>
      <div className="moderation-lookup-form">
        <label htmlFor="institution-lookup-slug" className="form-label">
          Slug / nama
        </label>
        <input
          id="institution-lookup-slug"
          className="form-input"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="nama-institusi atau Nama Institusi"
          aria-label="Cari institusi berdasarkan slug atau nama"
        />
        <Button size="sm" loading={searching} onClick={() => void lookup()}>
          Cari
        </Button>
      </div>

      {result && (
        <div className="moderation-result">
          <div>
            <strong>{result.name}</strong> · {result.slug} · verifikasi:{" "}
            {formatDisplayToken(result.verificationStatus)}
          </div>
          <div className="record-meta">
            Pemilik: {result.ownerName ?? "—"} ({result.ownerEmail ?? "—"})
          </div>
          <div className="moderation-status-row">
            Status operasional:{" "}
            {result.suspendedAt ? (
              <span className="status-badge" data-status="closed">
                Ditangguhkan ({result.suspensionReason ?? "tanpa alasan"})
              </span>
            ) : (
              <span className="status-badge" data-status="open">
                Aktif
              </span>
            )}
          </div>
          <div>
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
    <div className="moderation-console">
      <UserPanel />
      <InstitutionPanel />
    </div>
  );
}
