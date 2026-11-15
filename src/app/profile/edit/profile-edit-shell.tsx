"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OwnerProfileResponse, ProfileFieldValue } from "@/server/user-profile/profile-core";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";
import { Button, FormActionBar, Icon, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { ProfileCollectionsEditor } from "./profile-collections-editor";
import { AvatarUpload, BannerUpload, ResumeSection } from "./profile-media-controls";

// A key "<code>.<field>" holds the sentence for a refusal about one field.
const PROFILE_ERROR_COPY: Partial<Record<string, string>> = {
  "profile_invalid_value.username":
    "Username tidak valid. Gunakan 3 sampai 30 huruf kecil, angka, atau garis bawah.",
  "profile_invalid_value.displayName": "Nama tampil maksimal 120 karakter.",
  "profile_invalid_value.location": "Lokasi maksimal 120 karakter.",
  "profile_invalid_value.bio": "Bio maksimal 300 karakter.",
  profile_username_reserved: "Username ini tidak tersedia.",
  profile_username_taken: "Username sudah dipakai akun lain.",
  profile_username_conflicts_with_institution:
    "Username ini sudah dipakai oleh institusi. Pilih username lain.",
};

const PROFILE_SAVE_FALLBACK = "Gagal menyimpan profil. Coba lagi.";

const refusalCopyKey = (
  code: string | undefined,
  field: string | undefined,
): string | undefined => {
  const fieldKey = `${code}.${field}`;
  return field && PROFILE_ERROR_COPY[fieldKey] ? fieldKey : code;
};

type Props = {
  profile: OwnerProfileResponse;
  expectedUserId: string;
};

const fieldValue = (f: ProfileFieldValue<string | number>): string => {
  if (f.status === "populated") return String(f.value);
  return "";
};

function FieldInput({
  label,
  name,
  value,
  onChange,
  multiline,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <div className="form-field profile-edit-field">
      <label className="form-label" htmlFor={`profile-${name}`}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={`profile-${name}`}
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="form-textarea"
        />
      ) : (
        <input
          id={`profile-${name}`}
          name={name}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="form-input"
        />
      )}
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
  const currentAvatarUrl =
    profile.avatarUrl.status === "populated" ? profile.avatarUrl.value : null;
  const currentBannerUrl =
    profile.bannerUrl.status === "populated" ? profile.bannerUrl.value : null;

  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSaving(true);

    const payload = {
      username: username.trim(),
      displayName: displayName.trim() || null,
      bio: bio.trim() || null,
      location: location.trim() || null,
    };

    try {
      const res = await sessionFetch(expectedUserId, "/api/v1/users/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { code?: string; details?: { fields?: string[] } };
        } | null;
        const copyKey = refusalCopyKey(data?.error?.code, data?.error?.details?.fields?.[0]);
        addToast({
          type: "error",
          message: errorMessageFor(copyKey, PROFILE_ERROR_COPY, PROFILE_SAVE_FALLBACK),
        });
      } else {
        // A success answer whose body is not JSON still ends in the connection catch below.
        await res.json();
        addToast({ type: "success", message: "Profil berhasil disimpan." });
        // Re-fetch the /profile server component so it shows the just-saved values.
        router.refresh();
      }
    } catch {
      addToast({ type: "error", message: "Gagal terhubung ke server. Coba lagi." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-edit">
      <form className="profile-edit-form" onSubmit={handleSubmit}>
        <section className="content-section">
          <div className="section-heading">
            <div>
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
            />
          </div>
        </section>

        <section className="content-section">
          <div className="section-heading">
            <div>
              <h2>Identitas publik</h2>
            </div>
          </div>
          <FieldInput
            label="Nama tampil"
            name="displayName"
            value={displayName}
            onChange={setDisplayName}
          />
          <FieldInput label="Bio" name="bio" value={bio} onChange={setBio} multiline />
          <FieldInput label="Lokasi" name="location" value={location} onChange={setLocation} />
          <div className="form-field profile-edit-field">
            <span className="form-label">Foto profil</span>
            <AvatarUpload expectedUserId={expectedUserId} currentUrl={currentAvatarUrl} />
          </div>
          <div className="form-field profile-edit-field">
            <span className="form-label">Sampul profil</span>
            <BannerUpload expectedUserId={expectedUserId} currentUrl={currentBannerUrl} />
          </div>
        </section>
      </form>

      <ResumeSection expectedUserId={expectedUserId} resume={profile.resume} />

      <ProfileCollectionsEditor expectedUserId={expectedUserId} initial={profile.collections} />

      <FormActionBar>
        <IconButton
          variant="plain"
          size="back"
          icon="arrow-left"
          label="Kembali ke profil"
          onClick={() => router.push("/profile")}
        />
        <div className="form-action-bar-end">
          <Button
            type="button"
            onClick={() => handleSubmit()}
            loading={saving}
            leadingIcon={<Icon name="save" />}
          >
            Simpan
          </Button>
        </div>
      </FormActionBar>
    </div>
  );
}
