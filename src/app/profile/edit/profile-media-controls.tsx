"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, CheckboxField, Icon, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { CroppedImageUpload } from "@/components/media/cropped-image-upload";
import { AVATAR_FRAME, BANNER_FRAME } from "@/lib/media/image-frames";
import { PROFILE_FILE_RULES } from "@/server/user-profile/profile-files-core";
import type { OwnerResume } from "@/server/user-profile/profile-collections-core";
import { ownerFetch, uploadProfileFile } from "./profile-file-upload";

const PROFILE_UPLOAD_BASE = "/api/v1/users/me/profile";
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
  return (
    <div className="pf-media">
      <CroppedImageUpload
        expectedUserId={expectedUserId}
        currentUrl={currentUrl}
        copy={{
          frame: AVATAR_FRAME,
          shape: "blob",
          rules: PROFILE_FILE_RULES.avatar,
          basePath: `${PROFILE_UPLOAD_BASE}/uploads/avatar`,
          modalTitle: "Sesuaikan foto profil",
          saveLabel: "Simpan foto",
          uploadLabel: "Foto",
          removeLabel: "Hapus foto profil",
          uploadedMessage: "Foto profil diperbarui.",
          removedMessage: "Foto profil dihapus.",
          hint: "JPG, PNG, atau WebP · maks 5 MB",
        }}
        preview={
          <span className="pf-media-avatar">
            {currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={currentUrl} alt="" />
            ) : (
              <Icon name="user" size="lg" aria-hidden="true" />
            )}
          </span>
        }
      />
    </div>
  );
}

// ── Banner ──────────────────────────────────────────────────────────────────

export function BannerUpload({
  expectedUserId,
  currentUrl,
}: {
  expectedUserId: string;
  currentUrl: string | null;
}) {
  return (
    <div className="pf-media pf-media-stacked">
      <CroppedImageUpload
        expectedUserId={expectedUserId}
        currentUrl={currentUrl}
        copy={{
          frame: BANNER_FRAME,
          shape: "rect",
          rules: PROFILE_FILE_RULES.banner,
          basePath: `${PROFILE_UPLOAD_BASE}/uploads/banner`,
          modalTitle: "Sesuaikan sampul profil",
          saveLabel: "Simpan sampul",
          uploadLabel: "Sampul",
          removeLabel: "Hapus sampul profil",
          uploadedMessage: "Sampul profil diperbarui.",
          removedMessage: "Sampul profil dihapus.",
          hint: `JPG, PNG, atau WebP · maks 8 MB · dipotong ke ${BANNER_FRAME.outputWidth}×${BANNER_FRAME.outputHeight}`,
        }}
        preview={
          <span className="pf-media-banner">
            {currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={currentUrl} alt="" />
            ) : null}
          </span>
        }
      />
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
          <CheckboxField
            className="pf-editor-check"
            checked={resume.isPublic}
            disabled={busy}
            onChange={(e) => onToggleVisibility(e.target.checked)}
          >
            Tampilkan resume di profil publik
          </CheckboxField>
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
            <IconButton
              icon="trash"
              label="Hapus resume"
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={onRemove}
            />
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
