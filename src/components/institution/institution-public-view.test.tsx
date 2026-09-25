// @vitest-environment jsdom
//
// WHAT THIS FILE EXISTS TO PIN (C2.2 / B5).
//
// The contact section has ONE disclosure kind for two different viewers: an unverified institution's
// contacts are shown to a member of that institution AND to a platform-ops account that has no
// membership at all (institution-public-service.ts:188-201). The members-only sentence is true for
// the first and false for the second — a Lombakita operator reading "hanya terlihat oleh anggota
// institusi" is being told they are a member of an institution they have never joined.
//
// So the notice is branched on `viewerIsPlatformOps`, and BOTH branches are asserted here: a test
// that only checked the operator's sentence would pass over an unconditional string that had simply
// been rewritten for everyone.
//
// NEITHER BRANCH OFFERS A LINK (LAUNCH-D161). No viewer of this notice has a route into the
// verification flow: the notice is reached only from the public view, and the page that renders it
// serves the workspace hub to owner and staff and admits them to the public view only as a preview,
// where the disclosure is `preview_hidden`. Both cases below assert the link's absence, so restoring
// it fails here.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstitutionPublicView } from "./institution-public-view";
import type { PublicInstitution } from "@/server/institution-workspace/institution-public-service";

const institutionWith = (
  contactDisclosure: PublicInstitution["contactDisclosure"],
): PublicInstitution => ({
  slug: "lk-univ",
  name: "LK University",
  institutionType: "university",
  description: null,
  about: null,
  isVerified: false,
  logoUrl: null,
  bannerUrl: null,
  contactName: "Panitia Expo",
  contactEmail: "panitia@example.test",
  contactPhone: "+62215550123",
  contactDisclosure,
  websiteUrl: null,
  socialLinks: [],
  personalOwnerUsername: null,
});

const renderNotice = (contactDisclosure: PublicInstitution["contactDisclosure"]) =>
  render(
    <InstitutionPublicView institution={institutionWith(contactDisclosure)} competitions={[]} />,
  );

describe("the unverified-contact notice", () => {
  it("tells a platform-ops viewer they are seeing it as Lombakita, and offers them no link", () => {
    renderNotice({
      kind: "members_only",
      viewerIsPlatformOps: true,
    });

    expect(
      screen.getByText(
        "Kontak ini terlihat oleh Anda sebagai tim Lombakita. Publik akan melihatnya setelah institusi terverifikasi.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Kontak ini hanya terlihat oleh anggota institusi. Publik akan melihatnya setelah institusi terverifikasi.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Ajukan verifikasi")).toBeNull();
  });

  it("tells a member they are seeing it as an insider, and offers them no link either", () => {
    renderNotice({
      kind: "members_only",
      viewerIsPlatformOps: false,
    });

    expect(
      screen.getByText(
        "Kontak ini hanya terlihat oleh anggota institusi. Publik akan melihatnya setelah institusi terverifikasi.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/sebagai tim Lombakita/)).toBeNull();
    expect(
      screen.queryByText("Ajukan verifikasi"),
      "the members-only notice offered a route into the verification flow, which no viewer can be in a position to take",
    ).toBeNull();
  });
});
