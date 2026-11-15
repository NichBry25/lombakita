"use client";

import { useCallback, useId, useRef, useState } from "react";
import { Button, CheckboxField, IconButton } from "@/components/ui";
import { FormField, FormInput, FormLabel, FormTextarea, SelectField } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { ownerFetch, PROFILE_FILE_REMOVE_FALLBACK, uploadProfileFile } from "./profile-file-upload";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";
import {
  SOCIAL_PLATFORMS,
  type CertificationEntry,
  type EducationEntry,
  type ExperienceEntry,
  type ProfileCollections,
  type SkillEntry,
  type SocialLinkEntry,
  type SocialPlatform,
} from "@/server/user-profile/profile-collections-core";

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  github: "GitHub",
  instagram: "Instagram",
  x: "X",
  website: "Website",
};

const BASE = "/api/v1/users/me/profile";

// "YYYY-MM-DD" (stored) <-> "YYYY-MM" (month input).
const toMonthInput = (value: string | null): string => (value ? value.slice(0, 7) : "");
const fromMonthInput = (value: string): string | null => (value ? `${value}-01` : null);

// A key "<code>.<field>" holds the sentence for a refusal about one field.
const COLLECTION_ERROR_COPY: Partial<Record<string, string>> = {
  profile_collection_invalid_value: "Gagal menyimpan data. Periksa kembali isian Anda.",
  profile_collection_not_found: "Entri ini sudah tidak ada. Muat ulang halaman.",
  "profile_collection_duplicate.name": "Keahlian ini sudah ditambahkan.",
  "profile_collection_duplicate.platform": "Tautan untuk platform ini sudah ditambahkan.",
  profile_collection_limit_reached: "Satu bagian paling banyak berisi 50 entri.",
};

type MutationMethod = "POST" | "PATCH" | "DELETE";

const COLLECTION_FALLBACK: Record<MutationMethod, string> = {
  POST: "Gagal menambahkan entri. Coba lagi.",
  PATCH: "Gagal menyimpan perubahan. Coba lagi.",
  DELETE: "Gagal menghapus entri. Coba lagi.",
};

const refusalCopyKey = (
  code: string | undefined,
  field: string | undefined,
): string | undefined => {
  const fieldKey = `${code}.${field}`;
  return field && COLLECTION_ERROR_COPY[fieldKey] ? fieldKey : code;
};

type MutationResult = { ok: boolean; entry?: unknown; code: string | null; message: string };
type Mutate = (method: MutationMethod, path: string, body?: unknown) => Promise<MutationResult>;
type AddToast = (t: { type: "success" | "error"; message: string }) => void;

type FormProps<D> = {
  initial: D;
  submitLabel: string;
  busy: boolean;
  onSubmit: (payload: unknown) => void;
  onCancel: () => void;
};

// --------------------------------------------------------------------------- shared plumbing

// Owns one collection's items + edit state and wires add/update/delete through the mutate helper.
// `addResetKey` bumps after a successful add so the add form (keyed by it) remounts cleared.
function useEditableCollection<T extends { id: string }>(
  initialItems: T[],
  collection: string,
  mutate: Mutate,
  addToast: AddToast,
  labels: { added: string; updated: string },
) {
  const [items, setItems] = useState<T[]>(initialItems);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addResetKey, setAddResetKey] = useState(0);
  const [isAdding, setIsAdding] = useState(false);

  const openAddForm = () => setIsAdding(true);
  const closeAddForm = () => setIsAdding(false);

  const add = async (payload: unknown): Promise<boolean> => {
    setBusy(true);
    const result = await mutate("POST", `/${collection}`, payload);
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return false;
    }
    setItems((prev) => [result.entry as T, ...prev]);
    setAddResetKey((k) => k + 1);
    setIsAdding(false);
    addToast({ type: "success", message: labels.added });
    return true;
  };

  const update = async (id: string, payload: unknown): Promise<void> => {
    setBusy(true);
    const result = await mutate("PATCH", `/${collection}/${id}`, payload);
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    setItems((prev) => prev.map((item) => (item.id === id ? (result.entry as T) : item)));
    setEditingId(null);
    addToast({ type: "success", message: labels.updated });
  };

  const remove = async (id: string): Promise<void> => {
    const result = await mutate("DELETE", `/${collection}/${id}`);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
    if (editingId === id) setEditingId(null);
    addToast({ type: "success", message: "Entri dihapus." });
  };

  return {
    items,
    editingId,
    setEditingId,
    busy,
    addResetKey,
    isAdding,
    openAddForm,
    closeAddForm,
    add,
    update,
    remove,
  };
}

// Wraps a freshly opened add form and puts focus on its first field when it mounts. The callback
// ref has a stable identity, so it runs once per mount and not on every render.
function FocusFirstFieldOnMount({ children }: { children: React.ReactNode }) {
  const focusFirstField = useCallback((wrapper: HTMLDivElement | null) => {
    wrapper?.querySelector<HTMLElement>("input, textarea, select")?.focus();
  }, []);

  return <div ref={focusFirstField}>{children}</div>;
}

// The "+" at the right end of the heading row is how a repeating section gets a new entry.
function SectionShell({
  title,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  addLabel?: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="content-section surface-card card-padding">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
        </div>
        {addLabel && onAdd ? (
          <IconButton icon="plus" variant="outline" label={addLabel} onClick={onAdd} />
        ) : null}
      </div>
      {children}
    </section>
  );
}

// A summary row with Edit + Delete controls, shown when an entry is not being edited. An optional
// `footer` renders below the row (used by certifications for their file control).
function EntryRow({
  title,
  subtitle,
  onEdit,
  onDelete,
  entityLabel,
  footer,
}: {
  title: string;
  subtitle?: string | null;
  onEdit: () => void;
  onDelete: () => void;
  entityLabel: string;
  footer?: React.ReactNode;
}) {
  return (
    <li className="pf-editor-item">
      <div className="pf-editor-item-main">
        <div>
          <p className="pf-entry-title">{title}</p>
          {subtitle ? <p className="pf-entry-sub">{subtitle}</p> : null}
        </div>
        <div className="pf-editor-actions">
          <IconButton
            icon="edit"
            label={`Ubah ${entityLabel}`}
            variant="outline"
            onClick={onEdit}
          />
          <IconButton
            icon="trash"
            label={`Hapus ${entityLabel}`}
            variant="outline"
            onClick={onDelete}
          />
        </div>
      </div>
      {footer}
    </li>
  );
}

function FormActions({
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pf-editor-form-actions">
      <Button type="button" variant="outline" size="sm" loading={busy} onClick={onSubmit}>
        {submitLabel}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Batal
      </Button>
    </div>
  );
}

// --------------------------------------------------------------------------- Experience

type ExperienceDraft = {
  title: string;
  organizationName: string;
  location: string;
  start: string;
  end: string;
  isCurrent: boolean;
  description: string;
};

const emptyExperienceDraft = (): ExperienceDraft => ({
  title: "",
  organizationName: "",
  location: "",
  start: "",
  end: "",
  isCurrent: false,
  description: "",
});

const experienceDraftFrom = (entry: ExperienceEntry): ExperienceDraft => ({
  title: entry.title,
  organizationName: entry.organizationName,
  location: entry.location ?? "",
  start: toMonthInput(entry.startDate),
  end: toMonthInput(entry.endDate),
  isCurrent: entry.isCurrent,
  description: entry.description ?? "",
});

const experienceDraftToPayload = (d: ExperienceDraft) => ({
  title: d.title,
  organizationName: d.organizationName,
  location: d.location || null,
  startDate: fromMonthInput(d.start),
  endDate: d.isCurrent ? null : fromMonthInput(d.end),
  isCurrent: d.isCurrent,
  description: d.description || null,
});

function ExperienceForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: FormProps<ExperienceDraft>) {
  const uid = useId();
  const [d, setD] = useState(initial);
  const set = (patch: Partial<ExperienceDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <div className="pf-editor-form">
      <FormField>
        <FormLabel htmlFor={`${uid}-title`} required>
          Jabatan
        </FormLabel>
        <FormInput
          id={`${uid}-title`}
          value={d.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-org`} required>
          Organisasi
        </FormLabel>
        <FormInput
          id={`${uid}-org`}
          value={d.organizationName}
          onChange={(e) => set({ organizationName: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-loc`} optional>
          Lokasi
        </FormLabel>
        <FormInput
          id={`${uid}-loc`}
          value={d.location}
          onChange={(e) => set({ location: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-start`} optional>
          Mulai
        </FormLabel>
        <FormInput
          id={`${uid}-start`}
          type="month"
          value={d.start}
          onChange={(e) => set({ start: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-end`} optional>
          Selesai
        </FormLabel>
        <FormInput
          id={`${uid}-end`}
          type="month"
          value={d.end}
          disabled={d.isCurrent}
          onChange={(e) => set({ end: e.target.value })}
        />
      </FormField>
      <CheckboxField
        className="pf-editor-check"
        checked={d.isCurrent}
        onChange={(e) => set({ isCurrent: e.target.checked })}
      >
        Masih berjalan
      </CheckboxField>
      <FormField>
        <FormLabel htmlFor={`${uid}-desc`} optional>
          Deskripsi
        </FormLabel>
        <FormTextarea
          id={`${uid}-desc`}
          value={d.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </FormField>
      <FormActions
        submitLabel={submitLabel}
        busy={busy}
        onSubmit={() => onSubmit(experienceDraftToPayload(d))}
        onCancel={onCancel}
      />
    </div>
  );
}

function ExperienceEditor({
  initial,
  mutate,
  addToast,
}: {
  initial: ExperienceEntry[];
  mutate: Mutate;
  addToast: AddToast;
}) {
  const c = useEditableCollection(initial, "experiences", mutate, addToast, {
    added: "Pengalaman ditambahkan.",
    updated: "Pengalaman diperbarui.",
  });

  return (
    <SectionShell title="Pengalaman" addLabel="Tambah pengalaman" onAdd={c.openAddForm}>
      <ul className="pf-editor-list">
        {c.items.map((entry) =>
          c.editingId === entry.id ? (
            <li key={entry.id}>
              <ExperienceForm
                initial={experienceDraftFrom(entry)}
                submitLabel="Simpan"
                busy={c.busy}
                onSubmit={(p) => c.update(entry.id, p)}
                onCancel={() => c.setEditingId(null)}
              />
            </li>
          ) : (
            <EntryRow
              key={entry.id}
              title={entry.title}
              subtitle={entry.organizationName}
              onEdit={() => c.setEditingId(entry.id)}
              onDelete={() => c.remove(entry.id)}
              entityLabel={`pengalaman ${entry.title}`}
            />
          ),
        )}
      </ul>
      {c.isAdding ? (
        <FocusFirstFieldOnMount>
          <ExperienceForm
            key={c.addResetKey}
            initial={emptyExperienceDraft()}
            submitLabel="Tambah pengalaman"
            busy={c.busy}
            onSubmit={(p) => c.add(p)}
            onCancel={c.closeAddForm}
          />
        </FocusFirstFieldOnMount>
      ) : null}
    </SectionShell>
  );
}

// --------------------------------------------------------------------------- Education

type EducationDraft = {
  school: string;
  degree: string;
  fieldOfStudy: string;
  startYear: string;
  endYear: string;
};

const emptyEducationDraft = (): EducationDraft => ({
  school: "",
  degree: "",
  fieldOfStudy: "",
  startYear: "",
  endYear: "",
});

const educationDraftFrom = (entry: EducationEntry): EducationDraft => ({
  school: entry.school,
  degree: entry.degree ?? "",
  fieldOfStudy: entry.fieldOfStudy ?? "",
  startYear: entry.startYear?.toString() ?? "",
  endYear: entry.endYear?.toString() ?? "",
});

const parseYear = (v: string): number | null => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

const educationDraftToPayload = (d: EducationDraft) => ({
  school: d.school,
  degree: d.degree || null,
  fieldOfStudy: d.fieldOfStudy || null,
  startYear: parseYear(d.startYear),
  endYear: parseYear(d.endYear),
});

function EducationForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: FormProps<EducationDraft>) {
  const uid = useId();
  const [d, setD] = useState(initial);
  const set = (patch: Partial<EducationDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <div className="pf-editor-form">
      <FormField>
        <FormLabel htmlFor={`${uid}-school`} required>
          Institusi
        </FormLabel>
        <FormInput
          id={`${uid}-school`}
          value={d.school}
          onChange={(e) => set({ school: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-degree`} optional>
          Gelar
        </FormLabel>
        <FormInput
          id={`${uid}-degree`}
          value={d.degree}
          onChange={(e) => set({ degree: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-field`} optional>
          Jurusan
        </FormLabel>
        <FormInput
          id={`${uid}-field`}
          value={d.fieldOfStudy}
          onChange={(e) => set({ fieldOfStudy: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-start`} optional>
          Tahun mulai
        </FormLabel>
        <FormInput
          id={`${uid}-start`}
          type="number"
          value={d.startYear}
          onChange={(e) => set({ startYear: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-end`} optional>
          Tahun lulus
        </FormLabel>
        <FormInput
          id={`${uid}-end`}
          type="number"
          value={d.endYear}
          onChange={(e) => set({ endYear: e.target.value })}
        />
      </FormField>
      <FormActions
        submitLabel={submitLabel}
        busy={busy}
        onSubmit={() => onSubmit(educationDraftToPayload(d))}
        onCancel={onCancel}
      />
    </div>
  );
}

function EducationEditor({
  initial,
  mutate,
  addToast,
}: {
  initial: EducationEntry[];
  mutate: Mutate;
  addToast: AddToast;
}) {
  const c = useEditableCollection(initial, "educations", mutate, addToast, {
    added: "Pendidikan ditambahkan.",
    updated: "Pendidikan diperbarui.",
  });

  return (
    <SectionShell title="Riwayat pendidikan" addLabel="Tambah pendidikan" onAdd={c.openAddForm}>
      <ul className="pf-editor-list">
        {c.items.map((entry) =>
          c.editingId === entry.id ? (
            <li key={entry.id}>
              <EducationForm
                initial={educationDraftFrom(entry)}
                submitLabel="Simpan"
                busy={c.busy}
                onSubmit={(p) => c.update(entry.id, p)}
                onCancel={() => c.setEditingId(null)}
              />
            </li>
          ) : (
            <EntryRow
              key={entry.id}
              title={entry.school}
              subtitle={entry.fieldOfStudy ?? entry.degree}
              onEdit={() => c.setEditingId(entry.id)}
              onDelete={() => c.remove(entry.id)}
              entityLabel={`pendidikan ${entry.school}`}
            />
          ),
        )}
      </ul>
      {c.isAdding ? (
        <FocusFirstFieldOnMount>
          <EducationForm
            key={c.addResetKey}
            initial={emptyEducationDraft()}
            submitLabel="Tambah pendidikan"
            busy={c.busy}
            onSubmit={(p) => c.add(p)}
            onCancel={c.closeAddForm}
          />
        </FocusFirstFieldOnMount>
      ) : null}
    </SectionShell>
  );
}

// --------------------------------------------------------------------------- Skills (add + delete only)

function SkillEditor({
  initial,
  mutate,
  addToast,
}: {
  initial: SkillEntry[];
  mutate: Mutate;
  addToast: AddToast;
}) {
  const c = useEditableCollection(initial, "skills", mutate, addToast, {
    added: "Keahlian ditambahkan.",
    updated: "Keahlian diperbarui.",
  });
  const [name, setName] = useState("");

  const add = async () => {
    if (!name.trim()) return;
    const ok = await c.add({ name });
    if (ok) setName("");
  };

  return (
    <SectionShell title="Keahlian">
      <ul className="pf-tags pf-tags-editable">
        {c.items.map((entry) => (
          <li key={entry.id} className="pf-tag">
            {entry.name}
            <button
              type="button"
              className="pf-tag-remove"
              onClick={() => c.remove(entry.id)}
              aria-label={`Hapus keahlian ${entry.name}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="pf-editor-inline">
        <FormInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tambah keahlian"
          aria-label="Nama keahlian"
        />
        <IconButton
          icon="plus"
          label="Tambah keahlian"
          variant="outline"
          disabled={c.busy}
          onClick={add}
        />
      </div>
    </SectionShell>
  );
}

// --------------------------------------------------------------------------- Certifications

type CertificationDraft = {
  name: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  credentialId: string;
  credentialUrl: string;
};

const emptyCertificationDraft = (): CertificationDraft => ({
  name: "",
  issuer: "",
  issueDate: "",
  expiryDate: "",
  credentialId: "",
  credentialUrl: "",
});

const certificationDraftFrom = (entry: CertificationEntry): CertificationDraft => ({
  name: entry.name,
  issuer: entry.issuer,
  issueDate: toMonthInput(entry.issueDate),
  expiryDate: toMonthInput(entry.expiryDate),
  credentialId: entry.credentialId ?? "",
  credentialUrl: entry.credentialUrl ?? "",
});

const certificationDraftToPayload = (d: CertificationDraft) => ({
  name: d.name,
  issuer: d.issuer,
  issueDate: fromMonthInput(d.issueDate),
  expiryDate: fromMonthInput(d.expiryDate),
  credentialId: d.credentialId || null,
  credentialUrl: d.credentialUrl || null,
});

function CertificationForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: FormProps<CertificationDraft>) {
  const uid = useId();
  const [d, setD] = useState(initial);
  const set = (patch: Partial<CertificationDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <div className="pf-editor-form">
      <FormField>
        <FormLabel htmlFor={`${uid}-name`} required>
          Nama sertifikat
        </FormLabel>
        <FormInput
          id={`${uid}-name`}
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-issuer`} required>
          Penerbit
        </FormLabel>
        <FormInput
          id={`${uid}-issuer`}
          value={d.issuer}
          onChange={(e) => set({ issuer: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-issued`} optional>
          Tanggal terbit
        </FormLabel>
        <FormInput
          id={`${uid}-issued`}
          type="month"
          value={d.issueDate}
          onChange={(e) => set({ issueDate: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-expiry`} optional>
          Berlaku sampai
        </FormLabel>
        <FormInput
          id={`${uid}-expiry`}
          type="month"
          value={d.expiryDate}
          onChange={(e) => set({ expiryDate: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-cred-id`} optional>
          ID kredensial
        </FormLabel>
        <FormInput
          id={`${uid}-cred-id`}
          value={d.credentialId}
          onChange={(e) => set({ credentialId: e.target.value })}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-cred-url`} optional>
          URL kredensial
        </FormLabel>
        <FormInput
          id={`${uid}-cred-url`}
          value={d.credentialUrl}
          onChange={(e) => set({ credentialUrl: e.target.value })}
        />
      </FormField>
      <FormActions
        submitLabel={submitLabel}
        busy={busy}
        onSubmit={() => onSubmit(certificationDraftToPayload(d))}
        onCancel={onCancel}
      />
    </div>
  );
}

// Per-certification file control. Manages its own local file state (the parent editor seeds its
// item list once on mount, so a router.refresh would not update it — local state is authoritative
// here). After an upload the download link is unavailable until the next full page load; the file
// is attached and shown by name immediately.
function CertFileControl({
  expectedUserId,
  certId,
  initialFileName,
  initialFileUrl,
  addToast,
}: {
  expectedUserId: string;
  certId: string;
  initialFileName: string | null;
  initialFileUrl: string | null;
  addToast: AddToast;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(initialFileName);
  const [fileUrl] = useState<string | null>(initialFileUrl);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const result = await uploadProfileFile(
      expectedUserId,
      "certification",
      {
        uploadUrlPath: `/uploads/certifications/${certId}/upload-url`,
        recordPath: `/uploads/certifications/${certId}`,
      },
      file,
    );
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    setFileName(file.name);
    addToast({ type: "success", message: "Berkas sertifikat diunggah." });
  };

  const onRemove = async () => {
    setBusy(true);
    const result = await ownerFetch(
      expectedUserId,
      `/uploads/certifications/${certId}`,
      { method: "DELETE" },
      PROFILE_FILE_REMOVE_FALLBACK,
    );
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    setFileName(null);
    addToast({ type: "success", message: "Berkas sertifikat dihapus." });
  };

  return (
    <div className="pf-cert-file">
      {fileName ? (
        <span className="pf-entry-meta">
          Berkas: {fileName}
          {fileUrl ? (
            <>
              {" · "}
              <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                Lihat
              </a>
            </>
          ) : null}
        </span>
      ) : (
        <span className="pf-entry-meta">Belum ada berkas</span>
      )}
      <div className="pf-editor-form-actions">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="pf-visually-hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button
          type="button"
          className="pf-editor-edit"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {fileName ? "Ganti berkas" : "Unggah berkas"}
        </button>
        {fileName && (
          <button type="button" className="pf-editor-remove" disabled={busy} onClick={onRemove}>
            Hapus berkas
          </button>
        )}
      </div>
    </div>
  );
}

function CertificationEditor({
  expectedUserId,
  initial,
  mutate,
  addToast,
}: {
  expectedUserId: string;
  initial: CertificationEntry[];
  mutate: Mutate;
  addToast: AddToast;
}) {
  const c = useEditableCollection(initial, "certifications", mutate, addToast, {
    added: "Sertifikasi ditambahkan.",
    updated: "Sertifikasi diperbarui.",
  });

  return (
    <SectionShell title="Sertifikasi & lisensi" addLabel="Tambah sertifikasi" onAdd={c.openAddForm}>
      <ul className="pf-editor-list">
        {c.items.map((entry) =>
          c.editingId === entry.id ? (
            <li key={entry.id}>
              <CertificationForm
                initial={certificationDraftFrom(entry)}
                submitLabel="Simpan"
                busy={c.busy}
                onSubmit={(p) => c.update(entry.id, p)}
                onCancel={() => c.setEditingId(null)}
              />
            </li>
          ) : (
            <EntryRow
              key={entry.id}
              title={entry.name}
              subtitle={entry.issuer}
              onEdit={() => c.setEditingId(entry.id)}
              onDelete={() => c.remove(entry.id)}
              entityLabel={`sertifikasi ${entry.name}`}
              footer={
                <CertFileControl
                  expectedUserId={expectedUserId}
                  certId={entry.id}
                  initialFileName={entry.fileName}
                  initialFileUrl={entry.fileUrl}
                  addToast={addToast}
                />
              }
            />
          ),
        )}
      </ul>
      {c.isAdding ? (
        <FocusFirstFieldOnMount>
          <CertificationForm
            key={c.addResetKey}
            initial={emptyCertificationDraft()}
            submitLabel="Tambah sertifikasi"
            busy={c.busy}
            onSubmit={(p) => c.add(p)}
            onCancel={c.closeAddForm}
          />
        </FocusFirstFieldOnMount>
      ) : null}
    </SectionShell>
  );
}

// --------------------------------------------------------------------------- Social links

type SocialLinkDraft = { platform: SocialPlatform; url: string };

const emptySocialLinkDraft = (): SocialLinkDraft => ({ platform: "linkedin", url: "" });

const socialLinkDraftFrom = (entry: SocialLinkEntry): SocialLinkDraft => ({
  platform: entry.platform,
  url: entry.url,
});

function SocialLinkForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: FormProps<SocialLinkDraft>) {
  const uid = useId();
  const [d, setD] = useState(initial);
  const set = (patch: Partial<SocialLinkDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <div className="pf-editor-form">
      <FormField>
        <FormLabel htmlFor={`${uid}-platform`} required>
          Platform
        </FormLabel>
        <SelectField
          id={`${uid}-platform`}
          label="Platform"
          required
          value={d.platform}
          onChange={(value) => set({ platform: value as SocialPlatform })}
          options={SOCIAL_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor={`${uid}-url`} required>
          URL
        </FormLabel>
        <FormInput
          id={`${uid}-url`}
          value={d.url}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://"
        />
      </FormField>
      <FormActions
        submitLabel={submitLabel}
        busy={busy}
        onSubmit={() => onSubmit({ platform: d.platform, url: d.url })}
        onCancel={onCancel}
      />
    </div>
  );
}

function SocialLinkEditor({
  initial,
  mutate,
  addToast,
}: {
  initial: SocialLinkEntry[];
  mutate: Mutate;
  addToast: AddToast;
}) {
  const c = useEditableCollection(initial, "social-links", mutate, addToast, {
    added: "Tautan ditambahkan.",
    updated: "Tautan diperbarui.",
  });

  return (
    <SectionShell title="Tautan sosial" addLabel="Tambah tautan" onAdd={c.openAddForm}>
      <ul className="pf-editor-list">
        {c.items.map((entry) =>
          c.editingId === entry.id ? (
            <li key={entry.id}>
              <SocialLinkForm
                initial={socialLinkDraftFrom(entry)}
                submitLabel="Simpan"
                busy={c.busy}
                onSubmit={(p) => c.update(entry.id, p)}
                onCancel={() => c.setEditingId(null)}
              />
            </li>
          ) : (
            <EntryRow
              key={entry.id}
              title={PLATFORM_LABELS[entry.platform]}
              subtitle={entry.url}
              onEdit={() => c.setEditingId(entry.id)}
              onDelete={() => c.remove(entry.id)}
              entityLabel={`tautan ${PLATFORM_LABELS[entry.platform]}`}
            />
          ),
        )}
      </ul>
      {c.isAdding ? (
        <FocusFirstFieldOnMount>
          <SocialLinkForm
            key={c.addResetKey}
            initial={emptySocialLinkDraft()}
            submitLabel="Tambah tautan"
            busy={c.busy}
            onSubmit={(p) => c.add(p)}
            onCancel={c.closeAddForm}
          />
        </FocusFirstFieldOnMount>
      ) : null}
    </SectionShell>
  );
}

// --------------------------------------------------------------------------- Orchestrator

export function ProfileCollectionsEditor({
  expectedUserId,
  initial,
}: {
  expectedUserId: string;
  initial: ProfileCollections;
}) {
  const { addToast } = useToast();

  // Single request helper. Normalizes the JSON envelope so callers only branch on ok/message.
  const mutate: Mutate = async (method, path, body) => {
    try {
      const res = await sessionFetch(expectedUserId, `${BASE}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let data: {
        entry?: unknown;
        error?: { code?: string; details?: { fields?: string[] } };
      } = {};
      try {
        data = await res.json();
      } catch {
        /* empty body is fine */
      }
      if (!res.ok) {
        const code = data.error?.code ?? null;
        const copyKey = refusalCopyKey(data.error?.code, data.error?.details?.fields?.[0]);
        const message = errorMessageFor(
          copyKey,
          COLLECTION_ERROR_COPY,
          COLLECTION_FALLBACK[method],
        );
        return { ok: false, code, message };
      }
      return { ok: true, entry: data.entry, code: null, message: "" };
    } catch {
      return { ok: false, code: "network", message: "Gagal terhubung ke server. Coba lagi." };
    }
  };

  return (
    <div className="pf-editor">
      <ExperienceEditor initial={initial.experiences} mutate={mutate} addToast={addToast} />
      <EducationEditor initial={initial.educations} mutate={mutate} addToast={addToast} />
      <SkillEditor initial={initial.skills} mutate={mutate} addToast={addToast} />
      <CertificationEditor
        expectedUserId={expectedUserId}
        initial={initial.certifications}
        mutate={mutate}
        addToast={addToast}
      />
      <SocialLinkEditor initial={initial.socialLinks} mutate={mutate} addToast={addToast} />
    </div>
  );
}
