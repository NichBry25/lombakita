// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  PROFILE_FILE_RULES,
  ProfileFileError,
  parseFileMetadata,
  parseUploadRequest,
  profileFileErrorStatus,
} from "@/server/user-profile/profile-files-core";

describe("parseUploadRequest", () => {
  it("accepts an allowed mime type per kind", () => {
    expect(parseUploadRequest("avatar", { fileName: "me.png", mimeType: "image/png" })).toEqual({
      fileName: "me.png",
      mimeType: "image/png",
    });
    expect(parseUploadRequest("resume", { fileName: "cv.pdf", mimeType: "application/pdf" }).mimeType).toBe(
      "application/pdf",
    );
  });

  it("rejects a disallowed mime type", () => {
    expect(() =>
      parseUploadRequest("resume", { fileName: "cv.png", mimeType: "image/png" }),
    ).toThrow(ProfileFileError);
    expect(() =>
      parseUploadRequest("avatar", { fileName: "x.gif", mimeType: "image/gif" }),
    ).toThrow(ProfileFileError);
  });

  it("requires a fileName", () => {
    expect(() => parseUploadRequest("avatar", { mimeType: "image/png" })).toThrow(ProfileFileError);
  });
});

describe("parseFileMetadata", () => {
  const valid = {
    fileKey: "avatars/u1/abc",
    fileName: "me.png",
    sizeBytes: 1234,
    mimeType: "image/png",
  };

  it("accepts a valid record payload", () => {
    expect(parseFileMetadata("avatar", valid)).toEqual(valid);
  });

  it("rejects a non-positive size", () => {
    expect(() => parseFileMetadata("avatar", { ...valid, sizeBytes: 0 })).toThrow(ProfileFileError);
  });

  it("rejects a file over the kind's max size", () => {
    const over = PROFILE_FILE_RULES.avatar.maxBytes + 1;
    try {
      parseFileMetadata("avatar", { ...valid, sizeBytes: over });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as ProfileFileError).code).toBe("profile_file_too_large");
    }
  });

  it("rejects a missing fileKey", () => {
    expect(() => parseFileMetadata("avatar", { ...valid, fileKey: "" })).toThrow(ProfileFileError);
  });
});

describe("profileFileErrorStatus", () => {
  it("maps codes to statuses", () => {
    expect(profileFileErrorStatus("profile_file_not_found")).toBe(404);
    expect(profileFileErrorStatus("profile_file_unavailable")).toBe(503);
    expect(profileFileErrorStatus("profile_file_too_large")).toBe(422);
    expect(profileFileErrorStatus("profile_file_type_not_allowed")).toBe(422);
    expect(profileFileErrorStatus("profile_file_invalid_payload")).toBe(400);
    expect(profileFileErrorStatus("profile_file_invalid_key")).toBe(400);
  });
});
