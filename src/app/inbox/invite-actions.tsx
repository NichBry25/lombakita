"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { useModal, useToast } from "@/components/ui/primitives";

// Actionable accept/reject controls for an inbox invitation card. Acceptance is in-app
// and session-id matched server-side (the invitation is addressed by id; the server checks
// target_user_id). Mutates the caller's own data, so it uses `sessionFetch` (X-Expected-User-Id;
// CLAUDE.md Rule #16). Confirm + error states go through the shared modal/toast primitive (Rule 20) —
// no inline error state.

type InviteKind = "institution" | "team";
type InviteAction = "accept" | "decline";

const ENDPOINT_SEGMENT: Record<InviteKind, string> = {
  institution: "institution",
  team: "team",
};

const INVITE_ERROR_COPY: Partial<Record<string, string>> = {
  invitation_not_found: "Undangan tidak ditemukan. Muat ulang halaman.",
  team_invite_not_found: "Undangan tidak ditemukan. Muat ulang halaman.",
  invitation_not_actionable: "Undangan ini sudah tidak berlaku.",
  team_invite_not_actionable: "Undangan ini sudah tidak berlaku.",
  invitation_role_verification_required:
    "Undangan ini hanya bisa diterima oleh akun penyelenggara yang sudah diverifikasi. Verifikasi akun penyelenggara Anda terlebih dahulu.",
  invitation_already_member: "Anda sudah menjadi anggota institusi ini.",
  account_deactivated: "Data akun ini sudah dihapus. Tindakan ini tidak tersedia.",
  team_not_found: "Tim ini sudah tidak ada. Muat ulang halaman.",
  team_not_forming: "Tim ini sudah tidak menerima anggota baru.",
  team_invite_candidate_required:
    "Undangan tim hanya bisa diterima oleh akun kandidat. Verifikasi akun kandidat Anda terlebih dahulu.",
  team_candidate_already_member: "Anda sudah tergabung dalam tim untuk kompetisi ini.",
  forbidden: "Akun ini tidak dapat menerima undangan.",
};

const INVITE_FALLBACK: Record<InviteAction, string> = {
  accept: "Gagal menerima undangan. Coba lagi.",
  decline: "Gagal menolak undangan. Coba lagi.",
};

const readErrorMessage = async (response: Response, action: InviteAction): Promise<string> => {
  const code = await readErrorCode(response);
  return errorMessageFor(code, INVITE_ERROR_COPY, INVITE_FALLBACK[action]);
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
  // Which action is in flight, so the spinner lands on the button the user actually pressed.
  const [runningAction, setRunningAction] = useState<InviteAction | null>(null);

  const run = async (action: InviteAction) => {
    setRunningAction(action);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/me/invitations/${ENDPOINT_SEGMENT[kind]}/${invitationId}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        addToast({ type: "error", message: await readErrorMessage(res, action) });
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
      setRunningAction(null);
    }
  };

  const confirm = (action: InviteAction) => {
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
    <div className="inbox-actions">
      <Button
        type="button"
        variant="primary"
        size="sm"
        loading={runningAction === "accept"}
        disabled={runningAction !== null}
        onClick={() => confirm("accept")}
      >
        Terima
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={runningAction === "decline"}
        disabled={runningAction !== null}
        onClick={() => confirm("decline")}
      >
        Tolak
      </Button>
    </div>
  );
}
