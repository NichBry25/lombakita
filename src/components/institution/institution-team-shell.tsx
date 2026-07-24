"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, SelectField, Skeleton } from "@/components/ui";
import { getInstitutionRoleLabel } from "@/lib/access/role-labels";

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

export const InstitutionTeamShell = ({
  institutionSlug,
  isPersonal = false,
}: {
  institutionSlug: string;
  // Step 6.5f.1 — a personal institution is single-member: the staff-invite affordance is hidden.
  // The server guard (createInstitutionInvitation → invitation_personal_institution 403) remains the
  // authoritative enforcement.
  isPersonal?: boolean;
}) => {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Step 6.5e — a username OR an email; resolved server-side.
  const [identifier, setIdentifier] = useState("");
  const [inviteRole, setInviteRole] = useState<
    "institution_owner" | "institution_staff" | "institution_member"
  >("institution_staff");
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
    if (!identifier.trim()) return;

    setIsSubmitting(true);
    setFeedback(null);

    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ invitedIdentifier: identifier.trim(), invitedRole: inviteRole }),
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }

    setIdentifier("");
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
    <main className="page-shell app-page institution-team-page">
      <PageHeader
        eyebrow="Akses workspace"
        title="Staf dan undangan"
        description="Undang pengelola baru dan pantau undangan yang belum dijawab."
        backHref={`/institution/${institutionSlug}`}
        backLabel="Panel institusi"
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Undangan baru</p>
            <h2>Tambah pengelola</h2>
          </div>
        </div>
        {isPersonal ? (
          <p className="feedback" data-tone="info">
            Institusi personal hanya bisa memiliki satu anggota, sehingga tidak dapat mengundang
            staf atau anggota.
          </p>
        ) : (
          <form className="institution-invite-form" onSubmit={onInvite}>
            <input
              className="form-input"
              type="text"
              placeholder="Username atau email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            <SelectField
              label="Peran"
              value={inviteRole}
              onChange={(value) => setInviteRole(value as typeof inviteRole)}
              options={[
                {
                  value: "institution_staff",
                  label: getInstitutionRoleLabel("institution_staff"),
                },
                {
                  value: "institution_owner",
                  label: getInstitutionRoleLabel("institution_owner"),
                },
                {
                  value: "institution_member",
                  label: getInstitutionRoleLabel("institution_member"),
                },
              ]}
            />
            <Button type="submit" disabled={isSubmitting} loading={isSubmitting}>
              {isSubmitting ? "Mengirim..." : "Undang"}
            </Button>
          </form>
        )}

        {feedback ? (
          <p className="feedback" data-tone={feedback.type} role="status">
            {feedback.message}
          </p>
        ) : null}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Status akses</p>
            <h2>Undangan tertunda</h2>
          </div>
          <span className="status-badge data-text">{invitations.length}</span>
        </div>
        {isLoading ? (
          <div className="stack-sm" aria-label="Memuat undangan">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : invitations.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="Tidak ada undangan tertunda."
            description="Undangan yang dikirim akan tersusun di sini sampai dijawab atau dibatalkan."
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
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.invitedEmail}</td>
                    <td>{getInstitutionRoleLabel(inv.invitedRole)}</td>
                    <td className="data-text">{formatDate(inv.expiresAt)}</td>
                    <td>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void onCancel(inv.id)}
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
