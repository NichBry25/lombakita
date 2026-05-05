"use client";

import { useCallback, useEffect, useState } from "react";

type MemberRole = "institution_admin" | "institution_staff";

type Member = {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: MemberRole;
  joinedAt: string;
};

type FeedbackState = { type: "success" | "error"; message: string } | null;

type ConfirmRemove = { membershipId: string; name: string | null; email: string } | null;

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

const ROLE_LABELS: Record<MemberRole, string> = {
  institution_admin: "Admin",
  institution_staff: "Staf",
};

const BASE_URL = (institutionId: string) =>
  `/api/v1/institutions/by-id/${encodeURIComponent(institutionId)}/members`;

type Props = {
  institutionId: string;
  institutionSlug: string;
  actorUserId: string;
};

export const InstitutionMembersShell = ({ institutionId, actorUserId }: Props) => {
  const [members, setMembers] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [confirmRemove, setConfirmRemove] = useState<ConfirmRemove>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(BASE_URL(institutionId), {
      cache: "no-store",
      credentials: "include",
    });

    if (!response.ok) {
      setIsLoading(false);
      return;
    }

    const data = (await response.json()) as { members: Member[] };
    setMembers(data.members);
    setIsLoading(false);
  }, [institutionId]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadMembers(), 0);
    return () => window.clearTimeout(id);
  }, [loadMembers]);

  const onRoleChange = async (membershipId: string, newRole: MemberRole) => {
    setPendingAction(membershipId);
    setFeedback(null);

    const response = await fetch(
      `${BASE_URL(institutionId)}/${encodeURIComponent(membershipId)}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role: newRole }),
      },
    );

    setPendingAction(null);

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      return;
    }

    setFeedback({ type: "success", message: "Peran berhasil diperbarui." });
    void loadMembers();
  };

  const onConfirmRemove = (member: Member) => {
    setConfirmRemove({ membershipId: member.membershipId, name: member.name, email: member.email });
  };

  const onCancelRemove = () => setConfirmRemove(null);

  const onRemove = async () => {
    if (!confirmRemove) return;

    const { membershipId } = confirmRemove;
    setPendingAction(membershipId);
    setConfirmRemove(null);
    setFeedback(null);

    const response = await fetch(`${BASE_URL(institutionId)}/${encodeURIComponent(membershipId)}`, {
      method: "DELETE",
      credentials: "include",
    });

    setPendingAction(null);

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      return;
    }

    setFeedback({ type: "success", message: "Anggota berhasil dihapus." });
    void loadMembers();
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-14">
      <header>
        <h1 className="text-2xl font-semibold text-gleam">Manajemen Anggota</h1>
      </header>

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

      <section className="glass-card p-6">
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Memuat...</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Tidak ada anggota aktif.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-[var(--border)]">
                  <th className="pb-3 font-medium pr-4">Nama</th>
                  <th className="pb-3 font-medium pr-4">Email</th>
                  <th className="pb-3 font-medium pr-4">Peran</th>
                  <th className="pb-3 font-medium pr-4">Bergabung</th>
                  <th className="pb-3" />
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.userId === actorUserId;
                  const isActing = pendingAction === member.membershipId;
                  const otherRole: MemberRole =
                    member.role === "institution_admin" ? "institution_staff" : "institution_admin";

                  return (
                    <tr
                      key={member.membershipId}
                      className="border-b border-[var(--border)] last:border-0"
                    >
                      <td className="py-3 pr-4 font-medium">
                        {member.name ?? "—"}
                        {isSelf ? (
                          <span className="ml-2 text-xs text-[var(--text-muted)]">(Anda)</span>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-[var(--text-muted)]">{member.email}</td>
                      <td className="py-3 pr-4">
                        <span
                          className="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold"
                          style={{ background: "var(--badge-bg)", color: "var(--badge-text)" }}
                        >
                          {ROLE_LABELS[member.role]}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[var(--text-muted)]">
                        {formatDate(member.joinedAt)}
                      </td>
                      <td className="py-3">
                        {isSelf ? null : (
                          <div className="flex items-center gap-2">
                            <button
                              className="action-chip text-xs"
                              disabled={isActing}
                              onClick={() => void onRoleChange(member.membershipId, otherRole)}
                              type="button"
                            >
                              {isActing ? "..." : `Jadikan ${ROLE_LABELS[otherRole]}`}
                            </button>
                            <button
                              className="text-xs text-red-600 hover:underline disabled:opacity-50"
                              disabled={isActing}
                              onClick={() => onConfirmRemove(member)}
                              type="button"
                            >
                              Hapus
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmRemove ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="glass-card w-full max-w-sm p-6 space-y-4">
            <p className="font-medium">Hapus anggota ini?</p>
            <p className="text-sm text-[var(--text-muted)]">
              {confirmRemove.name ?? confirmRemove.email} akan dihapus dari institusi. Tindakan ini
              tidak dapat dibatalkan.
            </p>
            <div className="flex justify-end gap-3">
              <button className="action-chip text-sm" onClick={onCancelRemove} type="button">
                Batal
              </button>
              <button
                className="primary-button text-sm"
                style={{ background: "#dc2626" }}
                onClick={() => void onRemove()}
                type="button"
              >
                Hapus
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
};
