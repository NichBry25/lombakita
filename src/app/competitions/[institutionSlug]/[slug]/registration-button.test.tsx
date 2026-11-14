// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RegistrationButton } from "./registration-button";

const base = {
  registrationPath: "/competitions/seed-academy/seed-open/registration",
  signInPath: "/auth/login?callbackUrl=%2Fcompetitions%2Fseed-academy%2Fseed-open",
  candidateRoleOfferPath: null,
  isCancelled: false,
};

const HOST_OFFER_PATH =
  "/auth/verify-role?as=candidate&callbackUrl=%2Fcompetitions%2Fseed-academy%2Fseed-open";

describe("RegistrationButton", () => {
  it("sends a signed-out visitor to sign in from an open competition", () => {
    const html = renderToStaticMarkup(
      <RegistrationButton {...base} ctaState="open" isSignedIn={false} isCandidate={false} />,
    );

    expect(html).toContain(
      'href="/auth/login?callbackUrl=%2Fcompetitions%2Fseed-academy%2Fseed-open"',
    );
    expect(html).toContain("Daftar kompetisi");
    expect(html).not.toContain("disabled");
  });

  it("keeps the button disabled for a signed-in account that is not a candidate", () => {
    const html = renderToStaticMarkup(
      <RegistrationButton {...base} ctaState="open" isSignedIn={true} isCandidate={false} />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("Daftar kompetisi");
    expect(html).not.toContain("href");
  });

  it("links a candidate to the registration page", () => {
    const html = renderToStaticMarkup(
      <RegistrationButton {...base} ctaState="open" isSignedIn={true} isCandidate={true} />,
    );

    expect(html).toContain('href="/competitions/seed-academy/seed-open/registration"');
  });

  it("keeps a not-yet-open competition disabled when signed out", () => {
    const html = renderToStaticMarkup(
      <RegistrationButton
        {...base}
        ctaState="not_yet_open"
        isSignedIn={false}
        isCandidate={false}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("Belum dibuka");
  });

  it("sends a signed-in host to add the participant role and come back", () => {
    const html = renderToStaticMarkup(
      <RegistrationButton
        {...base}
        ctaState="open"
        isSignedIn={true}
        isCandidate={false}
        candidateRoleOfferPath={HOST_OFFER_PATH}
      />,
    );

    expect(html).toContain(
      'href="/auth/verify-role?as=candidate&amp;callbackUrl=%2Fcompetitions%2Fseed-academy%2Fseed-open"',
    );
    expect(html).toContain("Daftar kompetisi");
    expect(html).not.toContain("disabled");
  });

  it("keeps a closed competition disabled for a host", () => {
    const html = renderToStaticMarkup(
      <RegistrationButton
        {...base}
        ctaState="closed"
        isSignedIn={true}
        isCandidate={false}
        candidateRoleOfferPath={HOST_OFFER_PATH}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("Pendaftaran ditutup");
    expect(html).not.toContain("href");
  });
});
