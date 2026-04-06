"use client";

import { signOut } from "next-auth/react";

export const SignOutButton = () => {
  const onClick = async (): Promise<void> => {
    await signOut({ callbackUrl: "/" });
  };

  return (
    <button
      className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
      onClick={() => {
        void onClick();
      }}
      type="button"
    >
      Sign out
    </button>
  );
};
