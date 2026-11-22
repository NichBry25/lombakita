"use client";

import { ButtonLink } from "@/components/ui";
import { HeaderAccountMenu } from "@/components/navigation/header-account-menu";

type HeaderIdentityProps = {
  sessionStatus: "loading" | "authenticated" | "unauthenticated";
  pathname: string;
  signInHref: string;
  // The page under the header is the sign-in form itself, so a second way in would drop its
  // return address.
  onSignInForm: boolean;
};

// The right end of the bar. While the session is unknown it reserves the width of "Masuk", so the
// bar does not shift when the answer arrives.
export function HeaderIdentity({
  sessionStatus,
  pathname,
  signInHref,
  onSignInForm,
}: HeaderIdentityProps) {
  if (sessionStatus === "authenticated") {
    return (
      <div className="header-identity">
        <HeaderAccountMenu pathname={pathname} />
      </div>
    );
  }
  if (onSignInForm) return null;
  if (sessionStatus === "loading") {
    return (
      <div className="header-identity">
        <span className="header-identity-reserve" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="header-identity">
      <ButtonLink href={signInHref} variant="outline" size="sm" className="header-sign-in">
        Masuk
      </ButtonLink>
    </div>
  );
}
