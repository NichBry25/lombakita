"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { getInstitutionRoleLabel } from "@/lib/access/role-labels";

type MemberRole = "institution_owner" | "institution_staff" | "institution_member";

const ROLE_OPTIONS: readonly MemberRole[] = [
  "institution_owner",
  "institution_staff",
  "institution_member",
];

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

const BASE_URL = (institutionSlug: string) =>
  `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/members`;

type Props = {
  institutionSlug: string;
  actorUserId: string;
};

export const InstitutionMembersShell = ({ institutionSlug, actorUserId }: Props) => {
  const [members, setMembers] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [confirmRemove, setConfirmRemove] = useState<ConfirmRemove>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(BASE_URL(institutionSlug), {
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
  }, [institutionSlug]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadMembers(), 0);
    return () => window.clearTimeout(id);
  }, [loadMembers]);

  const onRoleChange = async (membershipId: string, newRole: MemberRole) => {
    setPendingAction(membershipId);
    setFeedback(null);

    const response = await fetch(
      `${BASE_URL(institutionSlug)}/${encodeURIComponent(membershipId)}/role`,
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

    const response = await fetch(
      `${BASE_URL(institutionSlug)}/${encodeURIComponent(membershipId)}`,
      {
        method: "DELETE",
        credentials: "include",
      },
    );

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
    <main className="page-shell app-page institution-members-page">
      <PageHeader
        eyebrow="Tata kelola akses"
        title="Manajemen anggota"
        description="Tinjau anggota aktif, sesuaikan peran, dan cabut akses bila diperlukan."
        backHref={`/institution/${institutionSlug}`}
        backLabel="Panel institusi"
      />

      {feedback ? (
        <p className="feedback" data-tone={feedback.type} role="status">
          {feedback.message}
        </p>
      ) : null}

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Anggota aktif</p>
            <h2>Daftar akses institusi</h2>
          </div>
          <span className="status-badge data-text">{members.length}</span>
        </div>
        {isLoading ? (
          <div className="stack-sm" aria-label="Memuat anggota">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : members.length === 0 ? (
          <EmptyState
            icon="users"
            title="Belum ada anggota aktif."
            description="Anggota yang menerima undangan akan muncul dalam daftar ini."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table institution-members-table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Email</th>
                  <th>Peran</th>
                  <th>Bergabung</th>
                  <th>
                    <span className="sr-only">Tindakan</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.userId === actorUserId;
                  const isActing = pendingAction === member.membershipId;
                  const otherRoles = ROLE_OPTIONS.filter((role) => role !== member.role);

                  return (
                    <tr key={member.membershipId}>
                      <td>
                        {member.name ?? "—"}
                        {isSelf ? <span className="record-meta"> (Anda)</span> : null}
                      </td>
                      <td>{member.email}</td>
                      <td>
                        <span className="status-badge">{getInstitutionRoleLabel(member.role)}</span>
                      </td>
                      <td className="data-text">{formatDate(member.joinedAt)}</td>
                      <td>
                        {isSelf ? null : (
                          <div className="table-actions">
                            {otherRoles.map((role) => (
                              <Button
                                key={role}
                                variant="outline"
                                size="sm"
                                disabled={isActing}
                                onClick={() => void onRoleChange(member.membershipId, role)}
                                type="button"
                              >
                                {isActing ? "..." : `Jadikan ${getInstitutionRoleLabel(role)}`}
                              </Button>
                            ))}
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={isActing}
                              onClick={() => onConfirmRemove(member)}
                              type="button"
                            >
                              Hapus
                            </Button>
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
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-dialog">
            <div className="modal-header">
              <h2>Hapus anggota ini?</h2>
            </div>
            <p className="modal-body">
              {confirmRemove.name ?? confirmRemove.email} akan dihapus dari institusi. Tindakan ini
              tidak dapat dibatalkan.
            </p>
            <div className="modal-actions">
              <Button variant="outline" onClick={onCancelRemove} type="button">
                Batal
              </Button>
              <Button variant="danger" onClick={() => void onRemove()} type="button">
                Hapus
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
};
