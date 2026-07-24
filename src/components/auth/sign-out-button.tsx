"use client";

import { signOut } from "next-auth/react";
import { IconButton } from "@/components/ui";

type SignOutButtonProps = {
  className?: string;
};

// Logout is an unambiguous, icon-representable action (door + outward arrow), so it renders
// as an icon-only control with a localized accessible name.
export const SignOutButton = ({ className }: SignOutButtonProps) => {
  const onClick = async (): Promise<void> => {
    await signOut({ callbackUrl: "/auth/login" });
  };

  return (
    <IconButton
      className={className}
      icon="logout"
      label="Keluar"
      variant="outline"
      onClick={() => {
        void onClick();
      }}
    />
  );
};
