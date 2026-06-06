"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OwnerProfileResponse, ProfileFieldValue } from "@/server/user-profile/profile-core";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type Props = {
  profile: OwnerProfileResponse;
  expectedUserId: string;
};

const fieldValue = (f: ProfileFieldValue<string | number>): string => {
  if (f.status === "populated") return String(f.value);
  return "";
};

const isLocked = (f: ProfileFieldValue<string | number>): boolean => f.status === "scope-gated";

function FieldInput({
  label,
  name,
  value,
  locked,
  requiredRole,
  onChange,
  multiline,
  error,
}: {
  label: string;
  name: string;
  value: string;
  locked: boolean;
  requiredRole?: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  error?: string;
}) {
  const lockedNote = locked ? (
    <span style={{ fontSize: "0.78rem", color: "#9333ea", marginLeft: "0.5rem" }}>
      Verifikasi peran {requiredRole} untuk mengedit
    </span>
  ) : null;

  const borderColor = error ? "#dc2626" : "#ccc";

  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", fontWeight: 500, marginBottom: "0.25rem" }}>
        {label}
        {lockedNote}
      </label>
      {multiline ? (
        <textarea
          name={name}
          value={value}
          disabled={locked}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            padding: "0.5rem",
            borderRadius: 4,
            border: `1px solid ${borderColor}`,
            background: locked ? "#f5f5f5" : "#fff",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <input
          type="text"
          name={name}
          value={value}
          disabled={locked}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            padding: "0.5rem",
            borderRadius: 4,
            border: `1px solid ${borderColor}`,
            background: locked ? "#f5f5f5" : "#fff",
            boxSizing: "border-box",
          }}
        />
      )}
      {error && (
        <p style={{ color: "#dc2626", fontSize: "0.82rem", marginTop: "0.25rem" }}>{error}</p>
      )}
    </div>
  );
}

export function ProfileEditShell({ profile, expectedUserId }: Props) {
  const router = useRouter();

  const [username, setUsername] = useState(profile.username);
  const [displayName, setDisplayName] = useState(fieldValue(profile.displayName));
  const [bio, setBio] = useState(fieldValue(profile.bio));
  const [location, setLocation] = useState(fieldValue(profile.location));
  const [avatarUrl, setAvatarUrl] = useState(fieldValue(profile.avatarUrl));
  const [university, setUniversity] = useState(fieldValue(profile.university));
  const [major, setMajor] = useState(fieldValue(profile.major));
  const [graduationYear, setGraduationYear] = useState(fieldValue(profile.graduationYear));
  const [roleTitle, setRoleTitle] = useState(fieldValue(profile.roleTitle));
  const [organizationName, setOrganizationName] = useState(fieldValue(profile.organizationName));
  const [websiteUrl, setWebsiteUrl] = useState(fieldValue(profile.websiteUrl));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setSuccess(false);

    const payload: Record<string, string | number | null> = {
      username: username.trim(),
      displayName: displayName.trim() || null,
      bio: bio.trim() || null,
      location: location.trim() || null,
      avatarUrl: avatarUrl.trim() || null,
    };

    if (!isLocked(profile.university)) {
      payload.university = university.trim() || null;
      payload.major = major.trim() || null;
      const yr = parseInt(graduationYear, 10);
      payload.graduationYear = isNaN(yr) ? null : yr;
    }

    if (!isLocked(profile.roleTitle)) {
      payload.roleTitle = roleTitle.trim() || null;
      payload.organizationName = organizationName.trim() || null;
      payload.websiteUrl = websiteUrl.trim() || null;
    }

    try {
      const res = await sessionFetch(expectedUserId, "/api/v1/users/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        const errCode: string = data?.error?.code ?? "unknown";
        const errMsg: string = data?.error?.message ?? "Terjadi kesalahan saat menyimpan profil.";
        const details: { fields?: string[] } = data?.error?.details ?? {};

        if (errCode === SESSION_MISMATCH_CODE) {
          setError(SESSION_MISMATCH_MESSAGE);
        } else if (errCode === "profile_username_taken") {
          setFieldErrors({ username: "Username sudah dipakai akun lain." });
        } else if (errCode === "profile_reserved_username") {
          setFieldErrors({ username: "Username ini tidak tersedia." });
        } else if (details.fields && details.fields.length > 0) {
          const fe: Record<string, string> = {};
          for (const f of details.fields) {
            fe[f] = errMsg;
          }
          setFieldErrors(fe);
        } else {
          setError(errMsg);
        }
      } else {
        setSuccess(true);
        // On a successful save, return to the owner profile view. router.refresh() first so the
        // /profile server component re-fetches the just-saved values rather than a cached render.
        router.refresh();
        router.push("/profile");
      }
    } catch {
      setError("Gagal terhubung ke server. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };


  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <p
          style={{
            background: "#fee2e2",
            color: "#b91c1c",
            padding: "0.75rem",
            borderRadius: 4,
            marginBottom: "1rem",
          }}
        >
          {error}
        </p>
      )}
      {success && (
        <p
          style={{
            background: "#dcfce7",
            color: "#15803d",
            padding: "0.75rem",
            borderRadius: 4,
            marginBottom: "1rem",
          }}
        >
          Profil berhasil disimpan.
        </p>
      )}

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "0.95rem", color: "#444", marginBottom: "0.75rem" }}>Akun</h2>
        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", fontWeight: 500, marginBottom: "0.25rem" }}>
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem",
              borderRadius: 4,
              border: fieldErrors.username ? "1px solid #dc2626" : "1px solid #ccc",
              boxSizing: "border-box",
            }}
          />
          {fieldErrors.username && (
            <p style={{ color: "#dc2626", fontSize: "0.82rem", marginTop: "0.25rem" }}>
              {fieldErrors.username}
            </p>
          )}
        </div>
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "0.95rem", color: "#444", marginBottom: "0.75rem" }}>
          Informasi Umum
        </h2>
        <FieldInput
          label="Nama Tampil"
          name="displayName"
          value={displayName}
          locked={false}
          onChange={setDisplayName}
          error={fieldErrors.displayName}
        />
        <FieldInput
          label="Bio"
          name="bio"
          value={bio}
          locked={false}
          onChange={setBio}
          multiline
          error={fieldErrors.bio}
        />
        <FieldInput
          label="Lokasi"
          name="location"
          value={location}
          locked={false}
          onChange={setLocation}
          error={fieldErrors.location}
        />
        <FieldInput
          label="Avatar URL"
          name="avatarUrl"
          value={avatarUrl}
          locked={false}
          onChange={setAvatarUrl}
          error={fieldErrors.avatarUrl}
        />
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "0.95rem", color: "#444", marginBottom: "0.75rem" }}>
          Profil Kandidat
        </h2>
        <FieldInput
          label="Universitas"
          name="university"
          value={university}
          locked={isLocked(profile.university)}
          requiredRole="candidate"
          onChange={setUniversity}
          error={fieldErrors.university}
        />
        <FieldInput
          label="Jurusan"
          name="major"
          value={major}
          locked={isLocked(profile.major)}
          requiredRole="candidate"
          onChange={setMajor}
          error={fieldErrors.major}
        />
        <FieldInput
          label="Tahun Lulus"
          name="graduationYear"
          value={graduationYear}
          locked={isLocked(profile.graduationYear)}
          requiredRole="candidate"
          onChange={setGraduationYear}
          error={fieldErrors.graduationYear}
        />
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "0.95rem", color: "#444", marginBottom: "0.75rem" }}>
          Profil Rekruter
        </h2>
        <FieldInput
          label="Jabatan"
          name="roleTitle"
          value={roleTitle}
          locked={isLocked(profile.roleTitle)}
          requiredRole="recruiter"
          onChange={setRoleTitle}
          error={fieldErrors.roleTitle}
        />
        <FieldInput
          label="Organisasi"
          name="organizationName"
          value={organizationName}
          locked={isLocked(profile.organizationName)}
          requiredRole="recruiter"
          onChange={setOrganizationName}
          error={fieldErrors.organizationName}
        />
        <FieldInput
          label="Website"
          name="websiteUrl"
          value={websiteUrl}
          locked={isLocked(profile.websiteUrl)}
          requiredRole="recruiter"
          onChange={setWebsiteUrl}
          error={fieldErrors.websiteUrl}
        />
      </section>

      <button
        type="submit"
        disabled={saving}
        style={{
          padding: "0.6rem 1.5rem",
          background: saving ? "#94a3b8" : "#355795",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: saving ? "not-allowed" : "pointer",
          fontSize: "0.95rem",
        }}
      >
        {saving ? "Menyimpan..." : "Simpan"}
      </button>
    </form>
  );
}
