"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Button,
  EmptyState,
  FormInput,
  FormLabel,
  IconButton,
  MenuButton,
  PageHeader,
  SelectField,
  Skeleton,
  Table,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { useModal, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { getInstitutionRoleLabel } from "@/lib/access/role-labels";
import {
  COMPETITIONS_CHANGING_RETRY_MESSAGE,
  errorMessageFor,
  MEMBER_HOLDS_PLACE_MESSAGE,
} from "@/lib/errors/error-copy";
import { readErrorCode } from "@/lib/session/session-fetch";

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

type RefusalAction = "role" | "remove" | "invite" | "cancel";

const INVALID_PAYLOAD_MESSAGE =
  "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.";

const TEAM_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Hanya pemilik atau staf institusi yang dapat mengelola anggota.",
  member_invalid_payload: INVALID_PAYLOAD_MESSAGE,
  invitation_invalid_payload: INVALID_PAYLOAD_MESSAGE,
  member_invalid_role: "Peran yang dipilih tidak valid. Muat ulang halaman lalu coba lagi.",
  member_not_found: "Anggota tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  member_self_action: "Anda tidak dapat mengubah peran atau menghapus akun Anda sendiri.",
  role_escalation_forbidden:
    "Akun ini harus menyelesaikan verifikasi penyelenggara sebelum dapat menjadi pemilik atau staf.",
  last_owner_demotion_forbidden: "Institusi harus memiliki paling sedikit satu pemilik.",
  member_holds_competition_place: MEMBER_HOLDS_PLACE_MESSAGE,
  member_role_retry: COMPETITIONS_CHANGING_RETRY_MESSAGE,
  member_last_admin:
    "Pemilik terakhir tidak dapat dihapus. Institusi harus memiliki paling sedikit satu pemilik.",
  invitation_invalid_identifier: "Masukkan username atau alamat email yang valid.",
  invitation_invalid_role: "Peran undangan tidak valid. Muat ulang halaman lalu coba lagi.",
  invitation_recipient_not_found: "Tidak ada akun dengan username ini.",
  invitation_already_member: "Orang ini sudah menjadi anggota institusi.",
  invitation_already_pending: "Undangan untuk orang ini masih menunggu jawaban.",
  invitation_not_found: "Undangan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  invitation_not_actionable: "Undangan ini sudah tidak aktif, jadi tidak dapat dibatalkan.",
  invitation_blocked_trust_removed:
    "Status tepercaya akun Anda dicabut staf, jadi Anda tidak dapat mengundang pemilik atau staf. Minta pemilik atau staf lain di ruang kerja ini mengirim undangannya, atau hubungi staf Lombakita.",
  member_role_blocked_trust_removed:
    "Status tepercaya akun Anda dicabut staf, jadi Anda tidak dapat menjadikan siapa pun pemilik atau staf. Minta pemilik atau staf lain di ruang kerja ini mengubah perannya, atau hubungi staf Lombakita.",
};

const TEAM_FALLBACK: Record<RefusalAction, string> = {
  role: "Peran gagal diperbarui. Coba lagi.",
  remove: "Anggota gagal dihapus. Coba lagi.",
  invite: "Undangan gagal dikirim. Coba lagi.",
  cancel: "Undangan gagal dibatalkan. Coba lagi.",
};

const MEMBER_COLUMNS: readonly TableColumn[] = [
  { key: "name", header: "Nama", kind: "name" },
  { key: "email", header: "Email", kind: "text" },
  { key: "role", header: "Peran", kind: "text" },
  { key: "joinedAt", header: "Bergabung", kind: "date" },
  { key: "actions", header: "Tindakan", kind: "control", hideHeader: true },
];

const INVITATION_COLUMNS: readonly TableColumn[] = [
  { key: "email", header: "Email", kind: "name" },
  { key: "role", header: "Peran", kind: "text" },
  { key: "expiresAt", header: "Kedaluwarsa", kind: "date" },
  { key: "actions", header: "Tindakan", kind: "control", hideHeader: true },
];

// A long address may break after the "@", so a pop-up title that names it wraps there.
const withBreakAfterAt = (email: string): ReactNode => {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;
  return (
    <>
      {email.slice(0, atIndex + 1)}
      <wbr />
      {email.slice(atIndex + 1)}
    </>
  );
};

const membersUrl = (institutionSlug: string) =>
  `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/members`;

const invitationsUrl = (institutionSlug: string) =>
  `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/invitations`;

type Props = {
  institutionSlug: string;
  actorUserId: string;
};

export const InstitutionTeamShell = ({ institutionSlug, actorUserId }: Props) => {
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
  const { openModal } = useModal();

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
      const code = await readErrorCode(response);
      addToast({
        type: "error",
        message: errorMessageFor(code, TEAM_ERROR_COPY, TEAM_FALLBACK.role),
      });
      return;
    }

    addToast({ type: "success", message: "Peran berhasil diperbarui." });
    void loadMembers();
  };

  // The confirm pop-up shows the waiting and the failure, so this reports an outcome.
  const removeMember = async (membershipId: string): Promise<ModalOutcome> => {
    const response = await fetch(
      `${membersUrl(institutionSlug)}/${encodeURIComponent(membershipId)}`,
      {
        method: "DELETE",
        credentials: "include",
      },
    );

    if (!response.ok) {
      const code = await readErrorCode(response);
      return { ok: false, message: errorMessageFor(code, TEAM_ERROR_COPY, TEAM_FALLBACK.remove) };
    }

    addToast({ type: "success", message: "Anggota berhasil dihapus." });
    void loadMembers();
    return { ok: true };
  };

  const confirmRemoveMember = (member: Member) => {
    openModal({
      title: "Hapus anggota ini?",
      body: `${member.name ?? member.email} akan dihapus dari institusi. Tindakan ini tidak dapat dibatalkan.`,
      alert: true,
      actions: [
        { label: "Batal" },
        {
          label: "Hapus anggota",
          variant: "primary",
          onClick: () => removeMember(member.membershipId),
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
      const code = await readErrorCode(response);
      addToast({
        type: "error",
        message: errorMessageFor(code, TEAM_ERROR_COPY, TEAM_FALLBACK.invite),
      });
      setIsInviting(false);
      return;
    }

    setIdentifier("");
    addToast({ type: "success", message: "Undangan berhasil dikirim." });
    setIsInviting(false);
    void loadInvitations();
  };

  // The confirm pop-up shows the waiting and the failure, so this reports an outcome.
  const cancelInvitation = async (invitationId: string): Promise<ModalOutcome> => {
    const response = await fetch(
      `${invitationsUrl(institutionSlug)}/${encodeURIComponent(invitationId)}/cancel`,
      { method: "PATCH", credentials: "include" },
    );

    if (!response.ok) {
      const code = await readErrorCode(response);
      return { ok: false, message: errorMessageFor(code, TEAM_ERROR_COPY, TEAM_FALLBACK.cancel) };
    }

    addToast({ type: "success", message: "Undangan dibatalkan." });
    void loadInvitations();
    return { ok: true };
  };

  const confirmCancelInvitation = (invitation: Invitation) => {
    openModal({
      title: <>Batalkan undangan untuk {withBreakAfterAt(invitation.invitedEmail)}?</>,
      body: "Undangan ini tidak berlaku lagi. Anda bisa mengirim undangan baru kapan saja.",
      alert: true,
      actions: [
        { label: "Kembali" },
        {
          label: "Batalkan undangan",
          variant: "primary",
          onClick: () => cancelInvitation(invitation.id),
        },
      ],
    });
  };

  const buildMemberRow = (member: Member): TableRowData => {
    const displayName = member.name ?? member.email;
    const isSelf = member.userId === actorUserId;
    const isActing = pendingAction?.startsWith(`${member.membershipId}:`) ?? false;
    const isChangingRole = pendingAction?.startsWith(`${member.membershipId}:role:`) ?? false;
    const otherRoles = ROLE_OPTIONS.filter((role) => role !== member.role);

    return {
      key: member.membershipId,
      cells: {
        name: (
          <>
            {member.name ?? "—"}
            {isSelf ? <span className="record-meta"> (Anda)</span> : null}
          </>
        ),
        email: member.email,
        role: getInstitutionRoleLabel(member.role),
        joinedAt: <LocalDate value={member.joinedAt} format="shortDate" />,
        actions: isSelf ? null : (
          <div className="table-actions">
            <MenuButton
              icon="edit"
              label={`Ubah peran ${displayName}`}
              tooltip="Ubah peran"
              loading={isChangingRole}
              disabled={isActing}
              items={otherRoles.map((role) => ({
                key: role,
                label: `Jadikan ${getInstitutionRoleLabel(role).toLowerCase()}`,
                onSelect: () => void onRoleChange(member.membershipId, role),
              }))}
            />
            <IconButton
              icon="trash"
              label={`Hapus anggota ${displayName}`}
              variant="outline"
              disabled={isActing}
              onClick={() => confirmRemoveMember(member)}
            />
          </div>
        ),
      },
    };
  };

  const buildInvitationRow = (invitation: Invitation): TableRowData => ({
    key: invitation.id,
    cells: {
      email: invitation.invitedEmail,
      role: getInstitutionRoleLabel(invitation.invitedRole),
      expiresAt: <LocalDate value={invitation.expiresAt} format="shortDate" />,
      actions: (
        <IconButton
          icon="trash"
          label={`Batalkan undangan untuk ${invitation.invitedEmail}`}
          variant="outline"
          disabled={pendingAction !== null}
          onClick={() => confirmCancelInvitation(invitation)}
        />
      ),
    },
  });

  const memberRows = members.map(buildMemberRow);
  const invitationRows = invitations.map(buildInvitationRow);

  return (
    <main className="page-shell app-page institution-team-page">
      <PageHeader title="Tim institusi" backHref={`/institution/${institutionSlug}`} />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>Daftar akses institusi</h2>
          </div>
        </div>
        {isLoadingMembers ? (
          <div className="stack-sm" aria-label="Memuat anggota">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : members.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada anggota aktif"
            description="Undang pengelola pada formulir di bawah untuk menambah anggota."
          />
        ) : (
          <Table
            label="Daftar akses institusi"
            columns={MEMBER_COLUMNS}
            rows={memberRows}
            stacked
          />
        )}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>Tambah pengelola</h2>
          </div>
        </div>
        <form className="institution-invite-form" onSubmit={onInvite}>
          <div className="form-field">
            <FormLabel htmlFor="institution-invite-identifier" required>
              Username atau Email
            </FormLabel>
            <FormInput
              id="institution-invite-identifier"
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
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>Undangan tertunda</h2>
          </div>
        </div>
        {isLoadingInvitations ? (
          <div className="stack-sm" aria-label="Memuat undangan">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : invitations.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Tidak ada undangan tertunda"
            description="Undangan yang dikirim akan muncul di sini sampai dijawab atau dibatalkan."
          />
        ) : (
          <Table
            label="Undangan tertunda"
            columns={INVITATION_COLUMNS}
            rows={invitationRows}
            stacked
          />
        )}
      </section>
    </main>
  );
};
