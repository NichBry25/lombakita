"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon } from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import type { OwnerResume } from "@/server/user-profile/profile-collections-core";
import { AvatarCropEditor, type AvatarCropApi } from "./avatar-crop-editor";
import { ownerFetch, uploadProfileFile } from "./profile-file-upload";

const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp";
const RESUME_ACCEPT = "application/pdf";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ── Avatar ──────────────────────────────────────────────────────────────────

export function AvatarUpload({
  expectedUserId,
  currentUrl,
}: {
  expectedUserId: string;
  currentUrl: string | null;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();
  const inputRef = useRef<HTMLInputElement>(null);
  const cropApiRef = useRef<AvatarCropApi | null>(null);
  const [busy, setBusy] = useState(false);

  const runUpload = async (file: File) => {
    setBusy(true);
    const result = await uploadProfileFile(
      expectedUserId,
      "avatar",
      { uploadUrlPath: "/uploads/avatar/upload-url", recordPath: "/uploads/avatar" },
      file,
    );
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    addToast({ type: "success", message: "Foto profil diperbarui." });
    router.refresh();
  };

  // Picking a file opens the crop modal; the cropped square is what actually uploads.
  const onFile = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      addToast({ type: "error", message: "Tipe berkas tidak didukung." });
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    openModal({
      title: "Sesuaikan foto profil",
      body: <AvatarCropEditor src={objectUrl} fileName={file.name} apiRef={cropApiRef} />,
      onClose: () => URL.revokeObjectURL(objectUrl),
      actions: [
        { label: "Batal", variant: "secondary", onClick: () => {} },
        {
          label: "Simpan foto",
          variant: "primary",
          autoClose: false,
          onClick: async () => {
            const cropped = await cropApiRef.current?.getCropped();
            closeModal();
            if (cropped) await runUpload(cropped);
          },
        },
      ],
    });
  };

  const onRemove = async () => {
    setBusy(true);
    const result = await ownerFetch(expectedUserId, "/uploads/avatar", { method: "DELETE" });
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    addToast({ type: "success", message: "Foto profil dihapus." });
    router.refresh();
  };

  return (
    <div className="pf-media">
      <span className="pf-media-avatar">
        {currentUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={currentUrl} alt="" />
        ) : (
          <Icon name="user" size="lg" aria-hidden="true" />
        )}
      </span>
      <div className="pf-media-actions">
        <input
          ref={inputRef}
          type="file"
          accept={AVATAR_ACCEPT}
          className="pf-visually-hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
        >
          Foto
        </Button>
        {currentUrl && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
            Hapus
          </Button>
        )}
        <p className="pf-media-hint">JPG, PNG, atau WebP · maks 5 MB</p>
      </div>
    </div>
  );
}

// ── Resume ────────────────────────────────────────────────────────────────────

export function ResumeSection({
  expectedUserId,
  resume,
}: {
  expectedUserId: string;
  resume: OwnerResume | null;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => router.refresh();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const result = await uploadProfileFile(
      expectedUserId,
      "resume",
      { uploadUrlPath: "/uploads/resume/upload-url", recordPath: "/uploads/resume" },
      file,
    );
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    addToast({ type: "success", message: "Resume diunggah." });
    refresh();
  };

  const onRemove = async () => {
    setBusy(true);
    const result = await ownerFetch(expectedUserId, "/uploads/resume", { method: "DELETE" });
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    addToast({ type: "success", message: "Resume dihapus." });
    refresh();
  };

  const onToggleVisibility = async (isPublic: boolean) => {
    setBusy(true);
    const result = await ownerFetch(expectedUserId, "/uploads/resume", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic }),
    });
    setBusy(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    refresh();
  };

  return (
    <section className="content-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Dokumen</p>
          <h2>Resume</h2>
        </div>
      </div>

      {resume ? (
        <div className="pf-resume">
          <div className="pf-resume-file">
            <Icon name="inbox" size="sm" aria-hidden="true" />
            <div>
              <p className="pf-entry-title">{resume.fileName}</p>
              <p className="pf-entry-meta">{formatBytes(resume.sizeBytes)}</p>
            </div>
            {resume.downloadUrl && (
              <a
                className="pf-website"
                href={resume.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Lihat
              </a>
            )}
          </div>
          <label className="pf-editor-check">
            <input
              type="checkbox"
              checked={resume.isPublic}
              disabled={busy}
              onChange={(e) => onToggleVisibility(e.target.checked)}
            />
            Tampilkan resume di profil publik
          </label>
          <div className="pf-editor-form-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
            >
              Resume
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
              Hapus
            </Button>
          </div>
        </div>
      ) : (
        <div className="pf-media-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
          >
            Resume
          </Button>
          <p className="pf-media-hint">PDF · maks 10 MB · privat secara default</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={RESUME_ACCEPT}
        className="pf-visually-hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
    </section>
  );
}
