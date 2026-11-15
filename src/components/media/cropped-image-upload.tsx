"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, IconButton } from "@/components/ui";
import { useModal, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { IMAGE_UPLOAD_MIME_TYPES, type ImageFrame } from "@/lib/media/image-frames";
import {
  UPLOAD_FALLBACK,
  deleteUploadedImage,
  uploadCroppedImage,
  type UploadRules,
} from "@/lib/media/upload-cropped-image";
import { ImageCropEditor, type ImageCropApi } from "@/components/media/image-crop-editor";

const ACCEPT = IMAGE_UPLOAD_MIME_TYPES.join(",");

// Everything an image upload surface needs beyond the flow itself, which is identical for every
// one of them: pick a file, crop it to a fixed frame, upload the crop, or remove what is stored.
export type CroppedImageUploadCopy = {
  frame: ImageFrame;
  shape: "blob" | "rect";
  rules: UploadRules;
  // API path owning the three verbs (POST <path>/upload-url, PUT <path>, DELETE <path>).
  basePath: string;
  modalTitle: string;
  saveLabel: string;
  uploadLabel: string;
  removeLabel: string;
  uploadedMessage: string;
  removedMessage: string;
  hint: string;
};

// Renders the file input, upload/remove controls and the crop modal. The caller supplies the
// preview markup because an avatar, a logo and a banner look nothing alike.
export function CroppedImageUpload({
  expectedUserId,
  currentUrl,
  copy,
  preview,
}: {
  expectedUserId: string;
  currentUrl: string | null;
  copy: CroppedImageUploadCopy;
  preview: ReactNode;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { openModal } = useModal();
  const inputRef = useRef<HTMLInputElement>(null);
  const cropApiRef = useRef<ImageCropApi | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  // The crop pop-up owns the waiting and failure states, so a failed upload leaves it open with the
  // image still in place for another try.
  const uploadCroppedFrame = async (): Promise<ModalOutcome> => {
    const cropped = await cropApiRef.current?.getCropped();
    if (!cropped) return { ok: false, message: UPLOAD_FALLBACK };
    const result = await uploadCroppedImage(expectedUserId, copy.basePath, copy.rules, cropped);
    if (!result.ok) return result;
    addToast({ type: "success", message: copy.uploadedMessage });
    router.refresh();
    return { ok: true };
  };

  // Picking a file opens the crop modal; the cropped frame is what actually uploads.
  const onFile = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      addToast({ type: "error", message: "Tipe berkas tidak didukung." });
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    openModal({
      title: copy.modalTitle,
      wide: true,
      initialFocus: "field",
      body: (
        <ImageCropEditor
          src={objectUrl}
          fileName={file.name}
          frame={copy.frame}
          shape={copy.shape}
          apiRef={cropApiRef}
        />
      ),
      onClose: () => URL.revokeObjectURL(objectUrl),
      actions: [
        { label: "Batal" },
        { label: copy.saveLabel, variant: "primary", onClick: uploadCroppedFrame },
      ],
    });
  };

  const onRemove = async () => {
    setIsRemoving(true);
    const result = await deleteUploadedImage(expectedUserId, copy.basePath);
    setIsRemoving(false);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    addToast({ type: "success", message: copy.removedMessage });
    router.refresh();
  };

  return (
    <>
      {preview}
      <div className="pf-media-actions">
        {/* The visible Button is the real control; this input is only its file picker, so it is
            kept out of the tab order rather than sitting there unlabeled. */}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="pf-visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRemoving}
          onClick={() => inputRef.current?.click()}
          leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
        >
          {copy.uploadLabel}
        </Button>
        {currentUrl && (
          <IconButton
            icon="trash"
            label={copy.removeLabel}
            variant="outline"
            loading={isRemoving}
            onClick={onRemove}
          />
        )}
        <p className="pf-media-hint">{copy.hint}</p>
      </div>
    </>
  );
}
