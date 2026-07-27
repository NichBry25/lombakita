"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, IconButton, PageHeader, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
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
  const { addToast } = useToast();
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
    setPendingAction(`${membershipId}:role:${newRole}`);

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
      addToast({ type: "error", message });
      return;
    }

    addToast({ type: "success", message: "Peran berhasil diperbarui." });
    void loadMembers();
  };

  const onConfirmRemove = (member: Member) => {
    setConfirmRemove({ membershipId: member.membershipId, name: member.name, email: member.email });
  };

  const onCancelRemove = () => setConfirmRemove(null);

  const onRemove = async () => {
    if (!confirmRemove) return;

    const { membershipId } = confirmRemove;
    setPendingAction(`${membershipId}:remove`);
    setConfirmRemove(null);

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
      addToast({ type: "error", message });
      return;
    }

    addToast({ type: "success", message: "Anggota berhasil dihapus." });
    void loadMembers();
  };

  return (
    <main className="page-shell app-page institution-members-page">
      <PageHeader
        eyebrow="Tata kelola akses"
        title="Manajemen anggota"
        description="Tinjau anggota aktif, sesuaikan peran, dan cabut akses bila diperlukan."
        backHref={`/institution/${institutionSlug}`}
        backLabel="Kembali"
      />

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
            description="Undang pengelola untuk menambah anggota di sini."
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
                  const isActing = pendingAction?.startsWith(`${member.membershipId}:`) ?? false;
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
                                loading={pendingAction === `${member.membershipId}:role:${role}`}
                                disabled={isActing}
                                onClick={() => void onRoleChange(member.membershipId, role)}
                                type="button"
                              >
                                {`Jadikan ${getInstitutionRoleLabel(role)}`}
                              </Button>
                            ))}
                            <IconButton
                              icon="trash"
                              label={`Hapus ${member.name ?? member.email}`}
                              variant="danger"
                              size="sm"
                              loading={pendingAction === `${member.membershipId}:remove`}
                              disabled={isActing}
                              onClick={() => onConfirmRemove(member)}
                            />
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
