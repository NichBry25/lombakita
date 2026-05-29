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
  | { phase: "info"; message: string }
  | { phase: "gate_error"; redirectTo: string }
  | { phase: "done"; type: "accepted" | "declined" };

const ROLE_LABELS: Record<string, string> = {
  institution_owner: "Pemilik Institusi",
  institution_staff: "Staf Institusi",
  institution_member: "Anggota Institusi",
};

const formatDate = (iso: string): string => {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

type ErrorPayload = { error?: { code?: string; message?: string; redirectTo?: string } };

const extractError = async (response: Response): Promise<ErrorPayload["error"]> => {
  try {
    const payload = (await response.json()) as ErrorPayload;
    return payload.error ?? {};
  } catch {
    return {};
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
        const err = await extractError(response);
        setState({ phase: "error", message: err?.message ?? "Permintaan gagal." });
        return;
      }

      const data = (await response.json()) as { invitation: InvitationMeta };
      const { invitation } = data;

      if (invitation.status !== "pending") {
        // `accepted` is a benign terminal state — render as info (green), not error (red).
        // `declined`/`expired`/`cancelled` remain neutral/red since they imply an unactionable
        // invitation.
        if (invitation.status === "accepted") {
          setState({
            phase: "info",
            message: "Undangan ini sudah diterima.",
          });
        } else {
          setState({
            phase: "error",
            message: `Undangan ini sudah ${invitation.status === "declined" ? "ditolak" : invitation.status === "expired" ? "kedaluwarsa" : "dibatalkan"}.`,
          });
        }
        return;
      }

      setState({ phase: "ready", meta: invitation });
    };

    void load();
  }, [token]);

  const onAccept = async (invitedRole: string) => {
    setIsActing(true);

    const response = await fetch(`/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      credentials: "include",
    });

    if (response.status === 401) {
      const data = (await response.json()) as { error?: { callbackUrl?: string } };
      const callbackUrl =
        data.error?.callbackUrl ?? `/invitations/${encodeURIComponent(token)}/accept`;
      router.push(`/auth/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      return;
    }

    if (!response.ok) {
      const err = await extractError(response);
      if (err?.code === "invitation_role_verification_required" && err.redirectTo) {
        setState({ phase: "gate_error", redirectTo: err.redirectTo });
      } else {
        setState({ phase: "error", message: err?.message ?? "Permintaan gagal." });
      }
      setIsActing(false);
      return;
    }

    setState({ phase: "done", type: "accepted" });
    const redirectPath =
      invitedRole === "institution_member" ? "/" : "/institution/workspace";
    setTimeout(() => {
      router.push(redirectPath);
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
      const err = await extractError(response);
      setState({ phase: "error", message: err?.message ?? "Permintaan gagal." });
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
            <p className="text-sm text-[var(--text-muted)] mt-2">Mengalihkan...</p>
          )}
        </div>
      </main>
    );
  }

  if (state.phase === "gate_error") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-20">
        <div className="glass-card p-8 space-y-4">
          <p className="text-sm font-medium text-red-600">Undangan ini memerlukan akun recruiter yang telah diverifikasi.</p>
          <p className="text-sm text-[var(--text-muted)]">
            Lengkapi verifikasi recruiter terlebih dahulu, lalu kembali ke tautan undangan ini.
          </p>
          <a
            href={state.redirectTo}
            className="primary-button inline-block text-center w-full"
          >
            Verifikasi Akun Recruiter
          </a>
        </div>
      </main>
    );
  }

  if (state.phase === "info") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-20">
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-green-700">{state.message}</p>
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
            onClick={() => void onAccept(meta.invitedRole)}
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
