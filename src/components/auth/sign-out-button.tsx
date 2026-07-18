"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui";

type SignOutButtonProps = {
  className?: string;
};

export const SignOutButton = ({ className }: SignOutButtonProps) => {
  const onClick = async (): Promise<void> => {
    await signOut({ callbackUrl: "/auth/login" });
  };

  return (
    <Button
      className={className}
      variant="outline"
      onClick={() => {
        void onClick();
      }}
      type="button"
    >
      Keluar
    </Button>
  );
};
