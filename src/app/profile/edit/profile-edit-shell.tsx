"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OwnerProfileResponse, ProfileFieldValue } from "@/server/user-profile/profile-core";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { Button, FormActionBar, Icon, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { ProfileCollectionsEditor } from "./profile-collections-editor";
import { AvatarUpload, ResumeSection } from "./profile-media-controls";

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

      const data = await res.json();

      if (!res.ok) {
        const errCode: string = data?.error?.code ?? "unknown";
        const errMsg: string = data?.error?.message ?? "Terjadi kesalahan saat menyimpan profil.";

        if (errCode === SESSION_MISMATCH_CODE) {
          addToast({ type: "error", message: SESSION_MISMATCH_MESSAGE });
        } else if (errCode === "profile_username_taken") {
          addToast({ type: "error", message: "Username sudah dipakai akun lain." });
        } else if (errCode === "profile_username_reserved") {
          addToast({ type: "error", message: "Username ini tidak tersedia." });
        } else {
          addToast({ type: "error", message: errMsg });
        }
      } else {
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
            />
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
        </section>
      </form>

      <ResumeSection expectedUserId={expectedUserId} resume={profile.resume} />

      <ProfileCollectionsEditor expectedUserId={expectedUserId} initial={profile.collections} />

      <FormActionBar>
        <IconButton
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
