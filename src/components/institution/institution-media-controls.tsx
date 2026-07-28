"use client";

import { Icon } from "@/components/ui";
import { CroppedImageUpload } from "@/components/media/cropped-image-upload";
import { AVATAR_FRAME, BANNER_FRAME } from "@/lib/media/image-frames";
import { INSTITUTION_MEDIA_RULES } from "@/lib/media/institution-media-rules";

const basePath = (institutionSlug: string, kind: "logo" | "banner"): string =>
  `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/profile/${kind}`;

// The logo is framed as a square, like a profile photo: it renders at the same small sizes on the
// competition detail organizer block and shares the avatar's crop frame.
export function InstitutionLogoUpload({
  expectedUserId,
  institutionSlug,
  currentUrl,
}: {
  expectedUserId: string;
  institutionSlug: string;
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
          rules: INSTITUTION_MEDIA_RULES.logo,
          basePath: basePath(institutionSlug, "logo"),
          modalTitle: "Sesuaikan logo institusi",
          saveLabel: "Simpan logo",
          uploadLabel: "Logo",
          removeLabel: "Hapus logo institusi",
          uploadedMessage: "Logo institusi diperbarui.",
          removedMessage: "Logo institusi dihapus.",
          hint: "JPG, PNG, atau WebP · maks 5 MB",
        }}
        preview={
          <span className="pf-media-avatar">
            {currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={currentUrl} alt="" />
            ) : (
              <Icon name="building" size="lg" aria-hidden="true" />
            )}
          </span>
        }
      />
    </div>
  );
}

export function InstitutionBannerUpload({
  expectedUserId,
  institutionSlug,
  currentUrl,
}: {
  expectedUserId: string;
  institutionSlug: string;
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
          rules: INSTITUTION_MEDIA_RULES.banner,
          basePath: basePath(institutionSlug, "banner"),
          modalTitle: "Sesuaikan sampul institusi",
          saveLabel: "Simpan sampul",
          uploadLabel: "Sampul",
          removeLabel: "Hapus sampul institusi",
          uploadedMessage: "Sampul institusi diperbarui.",
          removedMessage: "Sampul institusi dihapus.",
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
