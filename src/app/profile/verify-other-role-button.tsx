"use client";

import { Button } from "@/components/ui";
import { SHOW_SECOND_ROLE_PROMPT_EVENT } from "@/components/auth/second-role-prompt-modal";

// Client button on /profile that opens the second-role-prompt modal through
// SHOW_SECOND_ROLE_PROMPT_EVENT.
export function VerifyOtherRoleButton({ unverifiedRoleLabel }: { unverifiedRoleLabel: string }) {
  const onClick = () => {
    window.dispatchEvent(new Event(SHOW_SECOND_ROLE_PROMPT_EVENT));
  };

  return (
    <Button type="button" onClick={onClick} variant="outline" size="sm">
      Verifikasi sebagai {unverifiedRoleLabel}
    </Button>
  );
}
