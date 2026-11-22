import { describe, expect, it } from "vitest";
import { AVATAR_FRAME, BANNER_FRAME } from "@/lib/media/image-frames";
import { guideRegionInImage } from "./image-crop-editor";

// A 992 by 640 image has the crop area's ratio, so it covers the 496 by 320 area at a scale of
// exactly 0.5 and every expected number below is exact.
const IMAGE = { imageWidth: 992, imageHeight: 640, viewportWidth: 496 };

describe("guideRegionInImage", () => {
  it("returns the 280 by 280 avatar guide in image pixels at zoom 1", () => {
    const region = guideRegionInImage({
      ...IMAGE,
      zoom: 1,
      offset: { x: 0, y: 0 },
      shape: "blob",
      aspectRatio: AVATAR_FRAME.aspectRatio,
    });

    expect(region).toEqual({ x: 216, y: 40, width: 560, height: 560 });
  });

  it("returns the 464 by 116 cover guide in image pixels at zoom 1", () => {
    const region = guideRegionInImage({
      ...IMAGE,
      zoom: 1,
      offset: { x: 0, y: 0 },
      shape: "rect",
      aspectRatio: BANNER_FRAME.aspectRatio,
    });

    expect(region).toEqual({ x: 32, y: 204, width: 928, height: 232 });
  });

  it("follows the zoom and the offset of the image", () => {
    const offset = { x: -100, y: -50 };

    const avatar = guideRegionInImage({
      ...IMAGE,
      zoom: 2,
      offset,
      shape: "blob",
      aspectRatio: AVATAR_FRAME.aspectRatio,
    });
    const cover = guideRegionInImage({
      ...IMAGE,
      zoom: 2,
      offset,
      shape: "rect",
      aspectRatio: BANNER_FRAME.aspectRatio,
    });

    expect(avatar).toEqual({ x: 208, y: 70, width: 280, height: 280 });
    expect(cover).toEqual({ x: 116, y: 152, width: 464, height: 116 });
  });

  it("scales the guide with the area on a phone and frames the same part of the image", () => {
    const region = guideRegionInImage({
      imageWidth: 620,
      imageHeight: 400,
      viewportWidth: 310,
      zoom: 1,
      offset: { x: 0, y: 0 },
      shape: "blob",
      aspectRatio: AVATAR_FRAME.aspectRatio,
    });

    expect(region).toEqual({ x: 135, y: 25, width: 350, height: 350 });
  });
});
