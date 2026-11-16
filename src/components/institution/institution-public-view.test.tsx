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

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstitutionPublicView } from "./institution-public-view";
import type { CompetitionCardItem } from "@/components/competitions/competition-card";
import type { PublicInstitution } from "@/server/institution-workspace/institution-public-service";

// Render a real <a> so the competition cards render without a router context.
vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

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

describe("the competition list", () => {
  const FUTURE = new Date("2099-12-01T00:00:00.000Z");
  const competition: CompetitionCardItem = {
    id: "comp_1",
    slug: "lomba-x",
    title: "Lomba X",
    category: "hackathon",
    mode: "individual",
    registrationStartAt: null,
    registrationEndAt: FUTURE,
    eventStartAt: FUTURE,
    eventEndAt: FUTURE,
    resultAnnouncementAt: null,
    cancelledAt: null,
    hasPublishedResult: false,
    institutionSlug: "lk-univ",
    institutionName: "LK University",
    institutionLogoUrl: "https://files.test/lk.png",
  };

  it("renders the shared card: logo in the badge, the organiser named, and no arrow", () => {
    const { container } = render(
      <InstitutionPublicView
        institution={institutionWith({ kind: "hidden" })}
        competitions={[competition]}
      />,
    );

    const badgeLogo = container.querySelector(".competition-card .competition-cover-logo");
    expect(badgeLogo?.getAttribute("src")).toBe("https://files.test/lk.png");
    expect(container.querySelector(".competition-card .competition-organizer")?.textContent).toBe(
      "LK University",
    );
    expect(container.querySelector(".competition-card-arrow")).toBeNull();
  });
});
