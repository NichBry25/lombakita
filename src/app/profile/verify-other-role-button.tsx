"use client";

import { SHOW_SECOND_ROLE_PROMPT_EVENT } from "@/components/auth/second-role-prompt-modal";

// Client button on /profile that re-triggers the second-role-prompt modal even after the user
// has dismissed it this tab. The modal listens for SHOW_SECOND_ROLE_PROMPT_EVENT on window;
// dispatching here clears the dismissal flag and re-opens the dialog.
export function VerifyOtherRoleButton({ unverifiedRoleLabel }: { unverifiedRoleLabel: string }) {
  const onClick = () => {
    window.dispatchEvent(new Event(SHOW_SECOND_ROLE_PROMPT_EVENT));
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginTop: "0.75rem",
        padding: "0.4rem 1rem",
        background: "transparent",
        color: "#355795",
        border: "1px solid #355795",
        borderRadius: 6,
        fontSize: "0.85rem",
        cursor: "pointer",
      }}
    >
      Verifikasi sebagai {unverifiedRoleLabel}
    </button>
  );
}
