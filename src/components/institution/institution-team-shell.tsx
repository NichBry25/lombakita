"use client";

import { useCallback, useEffect, useState } from "react";

type Invitation = {
  id: string;
  invitedEmail: string;
  invitedRole: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

type FeedbackState = { type: "success" | "error"; message: string } | null;

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan gagal diproses.";
  } catch {
    return "Permintaan gagal diproses.";
  }
};

const formatDate = (iso: string): string => {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export const InstitutionTeamShell = ({ institutionSlug }: { institutionSlug: string }) => {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const loadInvitations = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/invitations`,
      { cache: "no-store", credentials: "include" },
    );

    if (!response.ok) {
      setIsLoading(false);
      return;
    }

    const data = (await response.json()) as { invitations: Invitation[] };
    setInvitations(data.invitations);
    setIsLoading(false);
  }, [institutionSlug]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadInvitations();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadInvitations]);

  const onInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim()) return;

    setIsSubmitting(true);
    setFeedback(null);

    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ invitedEmail: email.trim(), invitedRole: "institution_staff" }),
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }

    setEmail("");
    setFeedback({ type: "success", message: "Undangan berhasil dikirim." });
    setIsSubmitting(false);
    void loadInvitations();
  };

  const onCancel = async (invitationId: string) => {
    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/invitations/${encodeURIComponent(invitationId)}/cancel`,
      { method: "PATCH", credentials: "include" },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      return;
    }

    setFeedback({ type: "success", message: "Undangan dibatalkan." });
    void loadInvitations();
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-14">
      <header>
        <h1 className="text-2xl font-semibold text-gleam">Undang Staf</h1>
      </header>

      <section className="glass-card p-6 space-y-4">
        <form className="flex gap-3" onSubmit={onInvite}>
          <input
            className="form-input flex-1"
            type="email"
            placeholder="Email staf"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Mengirim..." : "Undang"}
          </button>
        </form>

        {feedback ? (
          <p
            className={`rounded-xl border px-3 py-2 text-sm ${
              feedback.type === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
            role="status"
          >
            {feedback.message}
          </p>
        ) : null}
      </section>

      <section className="glass-card p-6">
        <h2 className="text-base font-medium mb-4">Undangan Tertunda</h2>
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Memuat...</p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Tidak ada undangan tertunda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-[var(--border)]">
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Peran</th>
                  <th className="pb-2 font-medium">Kedaluwarsa</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-2 pr-4">{inv.invitedEmail}</td>
                    <td className="py-2 pr-4 capitalize">{inv.invitedRole.replace(/_/g, " ")}</td>
                    <td className="py-2 pr-4">{formatDate(inv.expiresAt)}</td>
                    <td className="py-2">
                      <button
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => void onCancel(inv.id)}
                        type="button"
                      >
                        Batalkan
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
};
