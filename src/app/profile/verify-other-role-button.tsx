"use client";

import { Button } from "@/components/ui";
import { SHOW_SECOND_ROLE_PROMPT_EVENT } from "@/components/auth/second-role-prompt-modal";

// Client button on /profile that re-triggers the second-role-prompt modal even after the user
// has dismissed it this tab. The modal listens for SHOW_SECOND_ROLE_PROMPT_EVENT on window;
// dispatching here clears the dismissal flag and re-opens the dialog.
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
