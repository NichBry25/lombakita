import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getOwnerProfile } from "@/server/user-profile/profile-service";
import type { ProfileFieldValue } from "@/server/user-profile/profile-core";
import { VerifyOtherRoleButton } from "./verify-other-role-button";

function FieldRow({
  label,
  field,
}: {
  label: string;
  field: ProfileFieldValue<string | number>;
}) {
  if (field.status === "scope-gated") {
    return (
      <tr>
        <td style={{ padding: "0.4rem 0.8rem 0.4rem 0", color: "#888", width: 160 }}>{label}</td>
        <td style={{ padding: "0.4rem 0", color: "#aaa" }}>
          <em>Tidak tersedia — verifikasi peran diperlukan</em>
          <span
            style={{
              marginLeft: "0.5rem",
              fontSize: "0.75rem",
              background: "#f3e8ff",
              color: "#7c3aed",
              borderRadius: 4,
              padding: "1px 6px",
            }}
          >
            terkunci
          </span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td style={{ padding: "0.4rem 0.8rem 0.4rem 0", color: "#888", width: 160 }}>{label}</td>
      <td style={{ padding: "0.4rem 0" }}>{field.status === "populated" ? field.value : "—"}</td>
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
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Profil Saya</h1>
        <Link
          href="/profile/edit"
          style={{
            padding: "0.4rem 1rem",
            background: "#355795",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.9rem",
          }}
        >
          Edit Profil
        </Link>
      </div>

      <p style={{ color: "#555", marginBottom: "0.5rem" }}>
        @{profile.username}
        {" · "}
        <span style={{ fontSize: "0.85rem" }}>
          {profile.role} ·{" "}
          {profile.candidateVerified && (
            <span style={{ color: "#16a34a" }}>kandidat terverifikasi</span>
          )}
          {profile.candidateVerified && profile.recruiterVerified && " · "}
          {profile.recruiterVerified && (
            <span style={{ color: "#16a34a" }}>rekruter terverifikasi</span>
          )}
        </span>
      </p>

      {/* Re-open the second-role-prompt modal. Only when exactly one role is verified. */}
      {profile.candidateVerified !== profile.recruiterVerified && (
        <div style={{ marginBottom: "1.5rem" }}>
          <VerifyOtherRoleButton
            unverifiedRoleLabel={profile.candidateVerified ? "rekruter" : "kandidat"}
          />
        </div>
      )}

      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1.5rem" }}>
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

      <p style={{ fontSize: "0.8rem", color: "#999" }}>Email: {profile.email}</p>
    </main>
  );
}
