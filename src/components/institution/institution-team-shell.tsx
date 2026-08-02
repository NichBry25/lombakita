"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  Feedback,
  IconButton,
  PageHeader,
  SelectField,
  Skeleton,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
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

type Invitation = {
  id: string;
  invitedEmail: string;
  invitedRole: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

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

const membersUrl = (institutionSlug: string) =>
  `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/members`;

const invitationsUrl = (institutionSlug: string) =>
  `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/invitations`;

type Props = {
  institutionSlug: string;
  actorUserId: string;
  // A personal institution is single-member: the invite affordance is hidden.
  // The server guard (createInstitutionInvitation → invitation_personal_institution 403) remains the
  // authoritative enforcement.
  isPersonal?: boolean;
};

export const InstitutionTeamShell = ({
  institutionSlug,
  actorUserId,
  isPersonal = false,
}: Props) => {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [isLoadingInvitations, setIsLoadingInvitations] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isInviting, setIsInviting] = useState(false);
  // A username OR an email; resolved server-side.
  const [identifier, setIdentifier] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("institution_staff");
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();

  const loadMembers = useCallback(async () => {
    setIsLoadingMembers(true);
    const response = await fetch(membersUrl(institutionSlug), {
      cache: "no-store",
      credentials: "include",
    });

    if (!response.ok) {
      setIsLoadingMembers(false);
      return;
    }

    const data = (await response.json()) as { members: Member[] };
    setMembers(data.members);
    setIsLoadingMembers(false);
  }, [institutionSlug]);

  const loadInvitations = useCallback(async () => {
    setIsLoadingInvitations(true);
    const response = await fetch(invitationsUrl(institutionSlug), {
      cache: "no-store",
      credentials: "include",
    });

    if (!response.ok) {
      setIsLoadingInvitations(false);
      return;
    }

    const data = (await response.json()) as { invitations: Invitation[] };
    setInvitations(data.invitations);
    setIsLoadingInvitations(false);
  }, [institutionSlug]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadMembers();
      void loadInvitations();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadMembers, loadInvitations]);

  const onRoleChange = async (membershipId: string, newRole: MemberRole) => {
    setPendingAction(`${membershipId}:role:${newRole}`);

    const response = await fetch(
      `${membersUrl(institutionSlug)}/${encodeURIComponent(membershipId)}/role`,
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

  const removeMember = async (membershipId: string) => {
    setPendingAction(`${membershipId}:remove`);

    const response = await fetch(
      `${membersUrl(institutionSlug)}/${encodeURIComponent(membershipId)}`,
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

  const confirmRemoveMember = (member: Member) => {
    openModal({
      title: "Hapus anggota ini?",
      body: `${member.name ?? member.email} akan dihapus dari institusi. Tindakan ini tidak dapat dibatalkan.`,
      actions: [
        { label: "Batal", variant: "secondary", onClick: closeModal },
        {
          label: "Hapus",
          variant: "danger",
          onClick: () => void removeMember(member.membershipId),
        },
      ],
    });
  };

  const onInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifier.trim()) return;

    setIsInviting(true);

    const response = await fetch(invitationsUrl(institutionSlug), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ invitedIdentifier: identifier.trim(), invitedRole: inviteRole }),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      setIsInviting(false);
      return;
    }

    setIdentifier("");
    addToast({ type: "success", message: "Undangan berhasil dikirim." });
    setIsInviting(false);
    void loadInvitations();
  };

  const cancelInvitation = async (invitationId: string) => {
    setPendingAction(`${invitationId}:cancel`);

    const response = await fetch(
      `${invitationsUrl(institutionSlug)}/${encodeURIComponent(invitationId)}/cancel`,
      { method: "PATCH", credentials: "include" },
    );

    setPendingAction(null);

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      return;
    }

    addToast({ type: "success", message: "Undangan dibatalkan." });
    void loadInvitations();
  };

  return (
    <main className="page-shell app-page institution-team-page">
      <PageHeader
        title="Tim institusi"
        description="Kelola anggota aktif, undang pengelola baru, dan pantau undangan yang belum dijawab."
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
        {isLoadingMembers ? (
          <div className="stack-sm" aria-label="Memuat anggota">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : members.length === 0 ? (
          <EmptyState
            icon="users"
            title="Belum ada anggota aktif."
            description="Undang pengelola pada formulir di bawah untuk menambah anggota."
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
                              onClick={() => confirmRemoveMember(member)}
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

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Undangan baru</p>
            <h2>Tambah pengelola</h2>
          </div>
        </div>
        {isPersonal ? (
          <Feedback tone="info">
            Institusi personal hanya bisa memiliki satu anggota, sehingga tidak dapat mengundang
            staf atau anggota.
          </Feedback>
        ) : (
          <form className="institution-invite-form" onSubmit={onInvite}>
            <div className="form-field">
              <label className="form-label" htmlFor="institution-invite-identifier">
                Username atau Email
              </label>
              <input
                id="institution-invite-identifier"
                className="form-input"
                type="text"
                placeholder="Username atau Email"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                required
              />
            </div>
            <SelectField
              label="Peran"
              value={inviteRole}
              onChange={(value) => setInviteRole(value as MemberRole)}
              options={ROLE_OPTIONS.map((role) => ({
                value: role,
                label: getInstitutionRoleLabel(role),
              }))}
            />
            <Button type="submit" loading={isInviting}>
              Undang
            </Button>
          </form>
        )}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Status akses</p>
            <h2>Undangan tertunda</h2>
          </div>
          <span className="status-badge data-text">{invitations.length}</span>
        </div>
        {isLoadingInvitations ? (
          <div className="stack-sm" aria-label="Memuat undangan">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : invitations.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="Tidak ada undangan tertunda."
            description="Undangan yang dikirim akan muncul di sini sampai dijawab atau dibatalkan."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Peran</th>
                  <th>Kedaluwarsa</th>
                  <th>
                    <span className="sr-only">Tindakan</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.invitedEmail}</td>
                    <td>{getInstitutionRoleLabel(invitation.invitedRole)}</td>
                    <td className="data-text">{formatDate(invitation.expiresAt)}</td>
                    <td>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={pendingAction === `${invitation.id}:cancel`}
                        disabled={pendingAction !== null}
                        onClick={() => void cancelInvitation(invitation.id)}
                        type="button"
                      >
                        Batalkan
                      </Button>
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
