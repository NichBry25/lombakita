import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getOwnerProfile } from "@/server/user-profile/profile-service";
import type { ProfileFieldValue } from "@/server/user-profile/profile-core";
import { VerifyOtherRoleButton } from "./verify-other-role-button";
import { ButtonLink, Icon, PageHeader } from "@/components/ui";

function FieldRow({ label, field }: { label: string; field: ProfileFieldValue<string | number> }) {
  if (field.status === "scope-gated") {
    return (
      <tr className="profile-field-row" data-locked="true">
        <th scope="row">{label}</th>
        <td>
          <em>Tidak tersedia — verifikasi peran diperlukan</em>
          <span className="status-badge">terkunci</span>
        </td>
      </tr>
    );
  }
  return (
    <tr className="profile-field-row">
      <th scope="row">{label}</th>
      <td>{field.status === "populated" ? field.value : "—"}</td>
    </tr>
  );
}

export default async function OwnerProfilePage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/profile");
  }

  const profile = await getOwnerProfile(session.user.id);

  return (
    <main className="page-shell app-page profile-page">
      <PageHeader
        eyebrow="Identitas akun"
        title="Profil saya"
        description="Atur identitas publik dan informasi peran yang digunakan di seluruh Lombakita."
        actions={
          <ButtonLink href="/profile/edit" variant="primary" size="sm">
            Edit profil
          </ButtonLink>
        }
      />

      <section className="profile-identity-card brand-band">
        <span className="profile-avatar" aria-hidden="true">
          <Icon name="user" size="xl" />
        </span>
        <div className="stack-xs">
          <h2>@{profile.username}</h2>
          <div className="profile-role-row">
            <span className="status-badge">{profile.role}</span>
            {profile.candidateVerified ? (
              <span className="status-badge" data-status="open">
                Kandidat terverifikasi
              </span>
            ) : null}
            {profile.recruiterVerified ? (
              <span className="status-badge" data-status="open">
                Rekruter terverifikasi
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {profile.candidateVerified !== profile.recruiterVerified && (
        <div>
          <VerifyOtherRoleButton
            unverifiedRoleLabel={profile.candidateVerified ? "rekruter" : "kandidat"}
          />
        </div>
      )}

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Detail profil</p>
            <h2>Informasi akun dan peran</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="profile-table">
            <tbody>
              <FieldRow label="Nama Tampil" field={profile.displayName} />
              <FieldRow label="Bio" field={profile.bio} />
              <FieldRow label="Lokasi" field={profile.location} />
              <FieldRow label="Avatar URL" field={profile.avatarUrl} />
              <FieldRow label="Universitas" field={profile.university} />
              <FieldRow label="Jurusan" field={profile.major} />
              <FieldRow label="Tahun Lulus" field={profile.graduationYear} />
              <FieldRow label="Jabatan" field={profile.roleTitle} />
              <FieldRow label="Organisasi" field={profile.organizationName} />
              <FieldRow label="Website" field={profile.websiteUrl} />
            </tbody>
          </table>
        </div>
        <p className="profile-email data-text">Email: {profile.email}</p>
      </section>
    </main>
  );
}
