"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { useModal, useToast } from "@/components/ui/primitives";

// Step 6.5e — actionable accept/reject controls for an inbox invitation card. Acceptance is in-app
// and session-id matched server-side (the invitation is addressed by id; the server checks
// target_user_id). Mutates the caller's own data, so it uses `sessionFetch` (X-Expected-User-Id;
// CLAUDE.md Rule #16). Confirm + error states go through the 6.5.2 modal/toast primitive (Rule 20) —
// no inline error state.

type InviteKind = "institution" | "team";

const ENDPOINT_SEGMENT: Record<InviteKind, string> = {
  institution: "institution",
  team: "team",
};

const readErrorMessage = async (response: Response): Promise<string> => {
  const code = await readErrorCode(response);
  if (code === SESSION_MISMATCH_CODE) return SESSION_MISMATCH_MESSAGE;
  try {
    const body = (await response.clone().json()) as { error?: { message?: string } };
    return body.error?.message ?? `Permintaan gagal (${response.status}).`;
  } catch {
    return `Permintaan gagal (${response.status}).`;
  }
};

export function InboxInviteActions({
  kind,
  invitationId,
  expectedUserId,
}: {
  kind: InviteKind;
  invitationId: string;
  expectedUserId: string;
}) {
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (action: "accept" | "decline") => {
    setBusy(true);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/me/invitations/${ENDPOINT_SEGMENT[kind]}/${invitationId}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        addToast({ type: "error", message: await readErrorMessage(res) });
        // A stale card (already accepted/declined/expired elsewhere) is dropped by refreshing.
        router.refresh();
        return;
      }
      addToast({
        type: "success",
        message: action === "accept" ? "Undangan diterima." : "Undangan ditolak.",
      });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan. Coba lagi." });
    } finally {
      setBusy(false);
    }
  };

  const confirm = (action: "accept" | "decline") => {
    openModal({
      title: action === "accept" ? "Terima undangan?" : "Tolak undangan?",
      body:
        action === "accept"
          ? "Anda akan bergabung sesuai undangan ini."
          : "Undangan ini akan ditolak dan tidak dapat dibatalkan.",
      closeable: true,
      actions: [
        {
          label: action === "accept" ? "Terima" : "Tolak",
          variant: action === "accept" ? "primary" : "secondary",
          autoClose: true,
          onClick: () => {
            void run(action);
          },
        },
        { label: "Batal", variant: "secondary", autoClose: true, onClick: () => {} },
      ],
    });
  };

  return (
    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
      <button
        type="button"
        disabled={busy}
        onClick={() => confirm("accept")}
        style={{ fontSize: "0.85em" }}
      >
        Terima
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => confirm("decline")}
        style={{ fontSize: "0.85em" }}
      >
        Tolak
      </button>
    </div>
  );
}
