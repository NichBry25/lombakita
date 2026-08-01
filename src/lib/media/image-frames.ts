// Fixed crop frames for uploaded profile and institution imagery. The browser crops to these exact
// dimensions before uploading, so every stored object already has the right shape and the render
// surfaces never have to guess how to fit an arbitrary image.
//
// The banner frame is shared by user profiles and institutions on purpose: a personal institution
// renders its owner's banner directly, so the two must be interchangeable.

export type ImageFrame = {
  aspectRatio: number;
  outputWidth: number;
  outputHeight: number;
};

export const AVATAR_FRAME: ImageFrame = {
  aspectRatio: 1,
  outputWidth: 512,
  outputHeight: 512,
};

export const BANNER_FRAME: ImageFrame = {
  aspectRatio: 4,
  outputWidth: 1584,
  outputHeight: 396,
};

// Source image types accepted from the user, across profile and institution uploads alike.
export const IMAGE_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// What every image crop is re-encoded to. The cropper draws to a canvas and exports JPEG, so the
// uploaded file's type is always this regardless of what the user picked.
export const CROPPED_IMAGE_MIME_TYPE = "image/jpeg";
export const CROPPED_IMAGE_QUALITY = 0.9;
