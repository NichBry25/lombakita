"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OwnerProfileResponse, ProfileFieldValue } from "@/server/user-profile/profile-core";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";

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
    <span className="profile-locked-note">Verifikasi peran {requiredRole} untuk mengedit</span>
  ) : null;

  return (
    <div className="form-field profile-edit-field" data-locked={locked || undefined}>
      <label className="form-label" htmlFor={`profile-${name}`}>
        {label}
        {lockedNote}
      </label>
      {multiline ? (
        <textarea
          id={`profile-${name}`}
          name={name}
          value={value}
          disabled={locked}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          className="form-textarea"
          aria-invalid={Boolean(error)}
        />
      ) : (
        <input
          id={`profile-${name}`}
          type="text"
          name={name}
          value={value}
          disabled={locked}
          onChange={(e) => onChange(e.target.value)}
          className="form-input"
          aria-invalid={Boolean(error)}
        />
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

export function ProfileEditShell({ profile, expectedUserId }: Props) {
  const router = useRouter();
  const { addToast } = useToast();

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFieldErrors({});

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
          addToast({ type: "error", message: SESSION_MISMATCH_MESSAGE });
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
          addToast({ type: "error", message: errMsg });
        }
      } else {
        addToast({ type: "success", message: "Profil berhasil disimpan." });
        // On a successful save, return to the owner profile view. router.refresh() first so the
        // /profile server component re-fetches the just-saved values rather than a cached render.
        router.refresh();
        router.push("/profile");
      }
    } catch {
      addToast({ type: "error", message: "Gagal terhubung ke server. Coba lagi." });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="profile-edit-form" onSubmit={handleSubmit}>
      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Akun</p>
            <h2>Alamat profil publik</h2>
          </div>
        </div>
        <div className="form-field profile-edit-field">
          <label className="form-label" htmlFor="profile-username">
            Username
          </label>
          <input
            id="profile-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="form-input"
            aria-invalid={Boolean(fieldErrors.username)}
          />
          {fieldErrors.username && <p className="form-error">{fieldErrors.username}</p>}
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Informasi umum</p>
            <h2>Identitas publik</h2>
          </div>
        </div>
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

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Profil kandidat</p>
            <h2>Riwayat pendidikan</h2>
          </div>
        </div>
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

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Profil rekruter</p>
            <h2>Identitas profesional</h2>
          </div>
        </div>
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

      <Button type="submit" disabled={saving} loading={saving}>
        {saving ? "Menyimpan..." : "Simpan"}
      </Button>
    </form>
  );
}
