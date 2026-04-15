"use client";

import { signOut } from "next-auth/react";

type SignOutButtonProps = {
  className?: string;
};

export const SignOutButton = ({ className }: SignOutButtonProps) => {
  const onClick = async (): Promise<void> => {
    await signOut({ callbackUrl: "/auth/sign-in" });
  };

  return (
    <button
      className={className ?? "primary-button"}
      onClick={() => {
        void onClick();
      }}
      type="button"
    >
      Sign out
    </button>
  );
};
