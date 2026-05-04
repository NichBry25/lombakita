"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type InvitationMeta = {
  id: string;
  institutionDisplayName: string;
  invitedRole: string;
  status: string;
  expiresAt: string;
};

type PageState =
  | { phase: "loading" }
  | { phase: "ready"; meta: InvitationMeta }
  | { phase: "error"; message: string }
  | { phase: "done"; type: "accepted" | "declined" };

const ROLE_LABELS: Record<string, string> = {
  institution_staff: "Staf Institusi",
};

const formatDate = (iso: string): string => {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan gagal.";
  } catch {
    return "Permintaan gagal.";
  }
};

export const InvitationAcceptShell = ({ token }: { token: string }) => {
  const router = useRouter();
  const [state, setState] = useState<PageState>({ phase: "loading" });
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    const load = async () => {
      const response = await fetch(`/api/v1/auth/invitations/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const message = await extractErrorMessage(response);
        setState({ phase: "error", message });
        return;
      }

      const data = (await response.json()) as { invitation: InvitationMeta };
      const { invitation } = data;

      if (invitation.status !== "pending") {
        setState({
          phase: "error",
          message: `Undangan ini sudah ${invitation.status === "accepted" ? "diterima" : invitation.status === "declined" ? "ditolak" : invitation.status === "expired" ? "kedaluwarsa" : "dibatalkan"}.`,
        });
        return;
      }

      setState({ phase: "ready", meta: invitation });
    };

    void load();
  }, [token]);

  const onAccept = async () => {
    setIsActing(true);

    const response = await fetch(
      `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`,
      { method: "POST", credentials: "include" },
    );

    if (response.status === 401) {
      const data = (await response.json()) as { error?: { callbackUrl?: string } };
      const callbackUrl = data.error?.callbackUrl ?? `/invitations/${encodeURIComponent(token)}/accept`;
      router.push(`/auth/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      return;
    }

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setState({ phase: "error", message });
      setIsActing(false);
      return;
    }

    setState({ phase: "done", type: "accepted" });
    setTimeout(() => {
      router.push("/institution/workspace");
    }, 1500);
  };

  const onDecline = async () => {
    setIsActing(true);

    const response = await fetch("/api/v1/auth/invitations/decline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setState({ phase: "error", message });
      setIsActing(false);
      return;
    }

    setState({ phase: "done", type: "declined" });
  };

  if (state.phase === "loading") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-20">
        <p className="text-sm text-[var(--text-muted)]">Memuat undangan...</p>
      </main>
    );
  }

  if (state.phase === "done") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-20">
        <div className="glass-card p-8 text-center">
          <p className="text-base font-medium">
            {state.type === "accepted" ? "Undangan diterima." : "Undangan ditolak."}
          </p>
          {state.type === "accepted" && (
            <p className="text-sm text-[var(--text-muted)] mt-2">Mengalihkan ke workspace...</p>
          )}
        </div>
      </main>
    );
  }

  if (state.phase === "error") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-20">
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-red-600">{state.message}</p>
        </div>
      </main>
    );
  }

  const { meta } = state;
  const roleLabel = ROLE_LABELS[meta.invitedRole] ?? meta.invitedRole;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-20">
      <div className="glass-card p-8 space-y-6 w-full">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-gleam">Undangan Bergabung</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Anda diundang bergabung sebagai{" "}
            <span className="font-medium text-foreground">{roleLabel}</span> di{" "}
            <span className="font-medium text-foreground">{meta.institutionDisplayName}</span>.
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            Berlaku hingga {formatDate(meta.expiresAt)}.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            className="primary-button flex-1"
            onClick={() => void onAccept()}
            disabled={isActing}
          >
            {isActing ? "Memproses..." : "Terima"}
          </button>
          <button
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--surface-hover)] disabled:opacity-50"
            onClick={() => void onDecline()}
            disabled={isActing}
            type="button"
          >
            Tolak
          </button>
        </div>
      </div>
    </main>
  );
};
