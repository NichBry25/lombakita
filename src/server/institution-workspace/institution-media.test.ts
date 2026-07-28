import { describe, expect, it } from "vitest";
import {
  resolveInstitutionMediaKeys,
  type InstitutionMediaSource,
} from "@/server/institution-workspace/institution-media";

const fullInstitution: InstitutionMediaSource = {
  institutionType: "company",
  logoR2Key: "institution-logos/inst_1/logo.jpg",
  bannerR2Key: "institution-banners/inst_1/banner.jpg",
};

const personalInstitution: InstitutionMediaSource = {
  institutionType: "personal",
  logoR2Key: null,
  bannerR2Key: null,
};

const ownerMedia = {
  avatarR2Key: "avatars/u_1/avatar.jpg",
  bannerR2Key: "banners/u_1/banner.jpg",
};

describe("resolveInstitutionMediaKeys", () => {
  it("uses a full institution's own stored keys", () => {
    expect(resolveInstitutionMediaKeys(fullInstitution, ownerMedia)).toEqual({
      logoKey: "institution-logos/inst_1/logo.jpg",
      bannerKey: "institution-banners/inst_1/banner.jpg",
    });
  });

  it("ignores the owner's imagery for a full institution even when it is loaded", () => {
    const { logoKey, bannerKey } = resolveInstitutionMediaKeys(
      { ...fullInstitution, logoR2Key: null, bannerR2Key: null },
      ownerMedia,
    );
    expect(logoKey).toBeNull();
    expect(bannerKey).toBeNull();
  });

  it("derives a personal institution's imagery from its owner's profile", () => {
    expect(resolveInstitutionMediaKeys(personalInstitution, ownerMedia)).toEqual({
      logoKey: "avatars/u_1/avatar.jpg",
      bannerKey: "banners/u_1/banner.jpg",
    });
  });

  it("prefers the owner's imagery over any key a personal institution somehow stored", () => {
    const strayKeys: InstitutionMediaSource = {
      institutionType: "personal",
      logoR2Key: "institution-logos/inst_2/stray.jpg",
      bannerR2Key: "institution-banners/inst_2/stray.jpg",
    };
    expect(resolveInstitutionMediaKeys(strayKeys, ownerMedia)).toEqual({
      logoKey: "avatars/u_1/avatar.jpg",
      bannerKey: "banners/u_1/banner.jpg",
    });
  });

  it("falls back to null when a personal institution's owner has no imagery", () => {
    expect(
      resolveInstitutionMediaKeys(personalInstitution, { avatarR2Key: null, bannerR2Key: null }),
    ).toEqual({ logoKey: null, bannerKey: null });
  });

  it("falls back to null when the owner was not loaded at all", () => {
    expect(resolveInstitutionMediaKeys(personalInstitution)).toEqual({
      logoKey: null,
      bannerKey: null,
    });
  });
});
