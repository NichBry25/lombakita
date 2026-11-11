"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, IconButton } from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { getAppRoleLabel } from "@/lib/access/role-labels";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { INSTITUTION_VERIFICATION_STATUS_LABELS } from "@/lib/institutions/verification-status-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";
import type { InstitutionVerificationStatus } from "@/server/db/schema";

type UserResult = {
  id: string;
  email: string;
  name: string | null;
  username: string;
  appRole: string;
  status: string;
  recruiterVerificationTier: string;
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

// Refusals an operator action surfaces as plain Indonesian rather than as a code. Duplicated from
// `src/server/accounts/deactivated-account.ts`, the de-identification service and the moderation
// service rather than imported: those modules pull in the database client, and this is a client
// component.
const OPERATOR_ACTION_ERROR_COPY: Partial<Record<string, string>> = {
  account_deactivated: "Data akun ini sudah dihapus. Tindakan ini tidak tersedia.",
  institution_has_no_owner:
    "Institusi ini tidak memiliki pemilik aktif, sehingga tidak dapat dipulihkan.",
  user_not_found: "Tidak ada pengguna dengan email itu.",
  note_required: "Catatan wajib diisi.",
  note_not_found: "Catatan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  invalid_note_target: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  tier_invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  tier_invalid_target: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  tier_account_not_found: "Akun tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  tier_target_not_recruiter_verified:
    "Akun ini belum terverifikasi sebagai rekruter, jadi tingkatnya tidak dapat dinaikkan.",
  email_required: "Masukkan email pengguna terlebih dahulu.",
  reason_required: "Alasan wajib diisi.",
  cannot_suspend_platform_ops: "Akun tim internal Lombakita tidak dapat ditangguhkan.",
  user_already_suspended:
    "Pengguna ini sudah ditangguhkan. Muat ulang halaman untuk melihat status terbaru.",
  user_not_suspended:
    "Pengguna ini tidak sedang ditangguhkan. Muat ulang halaman untuk melihat status terbaru.",
  slug_required: "Masukkan nama institusi terlebih dahulu.",
  institution_not_found: "Tidak ada institusi yang cocok dengan pencarian itu.",
  institution_already_suspended:
    "Institusi ini sudah ditangguhkan. Muat ulang halaman untuk melihat status terbaru.",
  institution_not_suspended:
    "Institusi ini tidak sedang ditangguhkan. Muat ulang halaman untuk melihat status terbaru.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  operator_actor_is_target: "Anda tidak dapat melakukan tindakan ini pada akun Anda sendiri.",
  operator_actor_conflicted:
    "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
};

const NOTE_SAVE_FALLBACK = "Catatan gagal disimpan. Coba lagi.";
const NOTES_LOAD_FALLBACK = "Catatan gagal dimuat. Coba lagi.";
const NOTE_ADD_FALLBACK = "Catatan gagal ditambahkan. Coba lagi.";
const RECRUITER_TIER_FALLBACK = "Tingkat rekruter gagal dinaikkan. Coba lagi.";
const DEIDENTIFY_FALLBACK = "Data akun gagal dihapus. Muat ulang halaman lalu periksa statusnya.";
const USER_LOOKUP_FALLBACK = "Pencarian pengguna gagal. Coba lagi.";
const INSTITUTION_LOOKUP_FALLBACK = "Pencarian institusi gagal. Coba lagi.";

const USER_ACTION_FALLBACK: Record<"suspend" | "unsuspend", string> = {
  suspend: "Pengguna gagal ditangguhkan. Coba lagi.",
  unsuspend: "Penangguhan gagal dicabut. Coba lagi.",
};

const INSTITUTION_ACTION_FALLBACK: Record<"suspend" | "reinstate", string> = {
  suspend: "Institusi gagal ditangguhkan. Coba lagi.",
  reinstate: "Institusi gagal dipulihkan. Coba lagi.",
};

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  const code = typeof data?.error?.code === "string" ? data.error.code : null;
  return errorMessageFor(code, OPERATOR_ACTION_ERROR_COPY, fallback);
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
        addToast({ type: "error", message: await readError(res, NOTE_SAVE_FALLBACK) });
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
          <Button size="sm" loading={busy} onClick={() => void save()}>
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
            — {note.createdByName ?? note.createdById} ·{" "}
            <LocalDate value={note.createdAt} format="numericDateTime" />
          </span>
          <IconButton
            icon="edit"
            label="Edit catatan ini"
            size="sm"
            onClick={() => setEditing(true)}
          />
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
        addToast({ type: "error", message: await readError(res, NOTES_LOAD_FALLBACK) });
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
        addToast({ type: "error", message: await readError(res, NOTE_ADD_FALLBACK) });
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
        <Button size="sm" loading={busy} onClick={() => void addNote()}>
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
        aria-label={`Alasan ${buttonLabel}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        variant={buttonLabel === "Tangguhkan" ? "danger" : "primary"}
        size="sm"
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

// The recruiter tier the elevation control targets. Duplicated from the service rather than
// imported: `src/server/recruiter-tier/recruiter-tier-service.ts` pulls in the database client, and
// this is a client component.
const ELEVATION_TARGET_TIER = "elevated";

// Every refusal of the de-identification action that has one fixed sentence. The codes absent from
// this map are the ones that count or name the institutions, teams or competitions still standing in
// the way: only the server knows those, and its message already has them substituted, so it is shown
// as it arrives.
const DEIDENTIFY_ERROR_COPY: Partial<Record<string, string>> = {
  deidentify_invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  deidentify_reason_required: "Alasan wajib diisi.",
  deidentify_reason_too_long: "Alasan terlalu panjang (maksimal 500 karakter).",
  deidentify_account_not_found: "Akun tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  deidentify_commit_failed:
    "Berkas sudah dihapus tetapi data akun belum diubah. Jalankan lagi untuk menyelesaikan.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  deidentify_confirmation_mismatch: "Nama pengguna konfirmasi tidak cocok.",
  deidentify_already_done: "Data akun ini sudah dihapus sebelumnya.",
  deidentify_target_is_operator: "Akun operator tidak dapat dihapus lewat tindakan ini.",
  operator_actor_is_target: "Anda tidak dapat menghapus akun Anda sendiri.",
  deidentify_storage_unavailable: "Penyimpanan berkas tidak tersedia. Coba lagi nanti.",
  deidentify_storage_failed: "Sebagian berkas gagal dihapus. Jalankan lagi untuk menyelesaikan.",
  deidentify_rehearsal_failed:
    "Penghapusan tidak dapat diproses. Tidak ada data yang diubah. Laporkan ke tim teknis.",
  deidentify_retry: "Sedang ada perubahan lain pada akun atau institusi ini. Coba lagi.",
};

const DEIDENTIFY_SERVER_MESSAGE_CODES = [
  "deidentify_last_owner",
  "deidentify_team_captain",
  "deidentify_personal_institution_has_published_competition",
];

async function readDeidentifyError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    const code = typeof data?.error?.code === "string" ? data.error.code : "";
    const message = typeof data?.error?.message === "string" ? data.error.message : "";

    if (DEIDENTIFY_SERVER_MESSAGE_CODES.includes(code)) {
      return message;
    }

    return errorMessageFor(code, DEIDENTIFY_ERROR_COPY, DEIDENTIFY_FALLBACK);
  } catch {
    return DEIDENTIFY_FALLBACK;
  }
}

function RecruiterTierAction({ account, onDone }: { account: UserResult; onDone: () => void }) {
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();
  const [busy, setBusy] = useState(false);

  const elevate = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/platform-ops/accounts/${account.id}/recruiter-tier`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: ELEVATION_TARGET_TIER }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res, RECRUITER_TIER_FALLBACK) });
        return;
      }
      const data = await res.json();
      addToast({
        type: "success",
        message:
          data?.changed === false
            ? "Akun ini sudah di tingkat penuh."
            : "Tingkat rekruter dinaikkan.",
      });
      onDone();
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="sm"
      loading={busy}
      onClick={() =>
        openModal({
          title: "Naikkan tingkat rekruter?",
          body: "Akun ini akan dapat membuat institusi dan menerbitkan kompetisi.",
          actions: [
            { label: "Batal", variant: "secondary", onClick: closeModal },
            { label: "Naikkan", variant: "primary", onClick: () => void elevate() },
          ],
        })
      }
    >
      Naikkan ke tingkat penuh
    </Button>
  );
}

function DeidentifyAction({ account, onDone }: { account: UserResult; onDone: () => void }) {
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();
  const [confirmUsername, setConfirmUsername] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const deidentify = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/platform-ops/accounts/${account.id}/deidentify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmUsername, reason }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readDeidentifyError(res) });
        return;
      }
      const data = await res.json();
      addToast({
        type: "success",
        message: `Data akun dihapus. ${data?.objectsDeleted ?? 0} berkas dihapus.`,
      });
      onDone();
    } catch {
      addToast({ type: "error", message: "Kesalahan jaringan." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm moderation-deidentify-form">
      <div className="form-field">
        <label className="form-label" htmlFor="deidentify-confirm-username">
          Ketik nama pengguna akun untuk konfirmasi
        </label>
        <input
          id="deidentify-confirm-username"
          className="form-input"
          value={confirmUsername}
          autoComplete="off"
          onChange={(e) => setConfirmUsername(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor="deidentify-reason">
          Alasan (contoh: permintaan melalui email tanggal 28 September 2026)
        </label>
        <input
          id="deidentify-reason"
          className="form-input"
          value={reason}
          autoComplete="off"
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Button
        variant="danger"
        size="sm"
        loading={busy}
        onClick={() =>
          openModal({
            title: "Hapus data akun ini?",
            body: `Akun @${account.username} akan dihapus. Nama, email, profil, dan berkas akun ini akan dihapus permanen, dan akun tidak dapat masuk lagi. Catatan pendaftaran, hasil lomba, keuangan, dan audit tetap disimpan tanpa data pribadi. Tindakan ini tidak dapat dibatalkan.`,
            actions: [
              { label: "Batal", variant: "secondary", onClick: closeModal },
              { label: "Hapus data", variant: "danger", onClick: () => void deidentify() },
            ],
          })
        }
      >
        Hapus data akun
      </Button>
    </div>
  );
}

function UserPanel({ initialEmail }: { initialEmail?: string }) {
  const { addToast } = useToast();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [result, setResult] = useState<UserResult | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (result && (result.appRole === "platform_ops" || result.appRole === "finance_ops")) {
      addToast({
        type: "error",
        message: `Akun ops internal (${getAppRoleLabel(result.appRole)}) tidak dapat ditangguhkan.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const lookup = async () => {
    setResult(null);
    setSearching(true);
    try {
      const res = await fetch(`/api/platform-ops/users/lookup?email=${encodeURIComponent(email)}`);
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res, USER_LOOKUP_FALLBACK) });
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

  // `?email=` is the deep-link the design gallery's moderation-user entry uses; it is
  // the only way that entry can render the looked-up panel.
  useEffect(() => {
    if (initialEmail) void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAction = async (action: "suspend" | "unsuspend", reason: string) => {
    if (!result) return;
    try {
      const res = await fetch(`/api/platform-ops/users/${result.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        addToast({ type: "error", message: await readError(res, USER_ACTION_FALLBACK[action]) });
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
            <strong>{result.name ?? "(tanpa nama)"}</strong> · {result.email} · Peran:{" "}
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
            {result.appRole === "platform_ops" ||
            result.appRole === "finance_ops" ||
            result.status === "deactivated" ? null : result.suspendedAt ? (
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
          {result.appRole === "recruiter" &&
            result.recruiterVerificationTier !== ELEVATION_TARGET_TIER &&
            result.status !== "deactivated" && (
              <div>
                <RecruiterTierAction account={result} onDone={() => void lookup()} />
              </div>
            )}
          {result.appRole !== "platform_ops" &&
            result.appRole !== "finance_ops" &&
            result.status !== "deactivated" && (
              // Not re-looked-up afterwards: the account's address is now the tombstone, so the email
              // in the search box resolves to nothing. The panel closes instead of reporting a
              // not-found for the account that was just deleted.
              <DeidentifyAction account={result} onDone={() => setResult(null)} />
            )}
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
        addToast({ type: "error", message: await readError(res, INSTITUTION_LOOKUP_FALLBACK) });
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
        const message = await readError(res, INSTITUTION_ACTION_FALLBACK[action]);
        addToast({ type: "error", message });
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
          <h2>Institusi</h2>
        </div>
      </div>
      <div className="moderation-lookup-form">
        <label htmlFor="institution-lookup-slug" className="form-label">
          Slug / Nama
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
            {INSTITUTION_VERIFICATION_STATUS_LABELS[
              result.verificationStatus as InstitutionVerificationStatus
            ] ?? formatDisplayToken(result.verificationStatus)}
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

export function ModerationConsole({ initialEmail }: { initialEmail?: string }) {
  return (
    <div className="moderation-console">
      <UserPanel initialEmail={initialEmail} />
      <InstitutionPanel />
    </div>
  );
}
