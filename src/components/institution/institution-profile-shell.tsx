"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, FormActionBar, Icon, IconButton, PageHeader, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type SocialPlatform = "linkedin" | "github" | "instagram" | "x" | "website";

const SOCIAL_PLATFORMS: Array<{ platform: SocialPlatform; label: string; placeholder: string }> = [
  { platform: "website", label: "Website", placeholder: "https://institusi.ac.id" },
  { platform: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/company/…" },
  { platform: "instagram", label: "Instagram", placeholder: "https://instagram.com/…" },
  { platform: "x", label: "X (Twitter)", placeholder: "https://x.com/…" },
  { platform: "github", label: "GitHub", placeholder: "https://github.com/…" },
];

type ProfileResponse = {
  profile: {
    about: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    websiteUrl: string | null;
    hasLogo: boolean;
    socialLinks: Array<{ platform: SocialPlatform; url: string }>;
    isEditable: boolean;
  };
};

const emptySocials = (): Record<SocialPlatform, string> => ({
  linkedin: "",
  github: "",
  instagram: "",
  x: "",
  website: "",
});

export const InstitutionProfileShell = ({
  institutionSlug,
  expectedUserId,
}: {
  institutionSlug: string;
  expectedUserId: string;
}) => {
  const router = useRouter();
  const { addToast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditable, setIsEditable] = useState(true);

  const [about, setAbout] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [socials, setSocials] = useState<Record<SocialPlatform, string>>(emptySocials());
  const [hasLogo, setHasLogo] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/profile`,
        { cache: "no-store", credentials: "include" },
      );
      if (!response.ok) {
        addToast({ type: "error", message: "Gagal memuat profil penyelenggara." });
        return;
      }
      const { profile } = (await response.json()) as ProfileResponse;
      setAbout(profile.about ?? "");
      setContactName(profile.contactName ?? "");
      setContactEmail(profile.contactEmail ?? "");
      setContactPhone(profile.contactPhone ?? "");
      const nextSocials = emptySocials();
      for (const link of profile.socialLinks) {
        nextSocials[link.platform] = link.url;
      }
      setSocials(nextSocials);
      setHasLogo(profile.hasLogo);
      setIsEditable(profile.isEditable);
    } catch {
      addToast({ type: "error", message: "Gagal memuat profil penyelenggara." });
    } finally {
      setIsLoading(false);
    }
  }, [institutionSlug, addToast]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleLogoSelect = (event: ChangeEvent<HTMLInputElement>) => {
    setLogoFile(event.target.files?.[0] ?? null);
  };

  const uploadLogo = async () => {
    if (!logoFile || logoBusy) return;
    setLogoBusy(true);
    try {
      const requestResponse = await sessionFetch(
        expectedUserId,
        `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/profile/logo`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contentType: logoFile.type || "image/png" }),
        },
      );
      if (!requestResponse.ok) {
        const body = (await requestResponse.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            body?.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body?.error?.message ?? "Gagal menyiapkan unggahan logo."),
        });
        return;
      }
      const { uploadUrl } = (await requestResponse.json()) as { uploadUrl: string };
      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": logoFile.type || "image/png" },
        body: logoFile,
      });
      if (!putResponse.ok) {
        addToast({ type: "error", message: "Unggahan logo ke penyimpanan gagal." });
        return;
      }
      addToast({ type: "success", message: "Logo berhasil diunggah." });
      setHasLogo(true);
      setLogoFile(null);
    } catch {
      addToast({ type: "error", message: "Unggahan logo gagal karena gangguan koneksi." });
    } finally {
      setLogoBusy(false);
    }
  };

  const onSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isSaving) return;
    setIsSaving(true);

    const socialLinks = SOCIAL_PLATFORMS.map(({ platform }) => ({
      platform,
      url: socials[platform].trim(),
    })).filter((link) => link.url.length > 0);

    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/profile`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            about,
            contactName,
            contactEmail,
            contactPhone,
            websiteUrl: socials.website,
            socialLinks,
          }),
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            body?.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body?.error?.message ?? "Gagal menyimpan profil. Coba lagi."),
        });
        return;
      }

      addToast({ type: "success", message: "Profil penyelenggara berhasil disimpan." });
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan profil karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        eyebrow="Profil publik"
        title="Profil penyelenggara"
        description="Informasi ini tampil di halaman kompetisi yang Anda selenggarakan."
      />

      <section className="content-section">
        {isLoading ? (
          <div className="stack-md" aria-label="Memuat profil penyelenggara">
            <Skeleton variant="title" />
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : !isEditable ? (
          <p className="muted-copy">
            Institusi personal tidak memiliki profil penyelenggara publik.
          </p>
        ) : (
          <form className="stack-md" onSubmit={onSubmit}>
            <div className="form-field">
              <label className="form-label" htmlFor="institution-profile-logo">
                Logo penyelenggara
              </label>
              <input
                id="institution-profile-logo"
                className="form-input"
                type="file"
                accept="image/*"
                onChange={handleLogoSelect}
              />
              <p className="form-help">
                {hasLogo
                  ? "Logo sudah tersimpan. Unggah berkas baru untuk menggantinya."
                  : "Belum ada logo. Unggah berkas gambar."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={uploadLogo}
                disabled={!logoFile}
                loading={logoBusy}
              >
                Unggah logo
              </Button>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-profile-about">
                Tentang penyelenggara
              </label>
              <textarea
                id="institution-profile-about"
                className="form-input"
                rows={5}
                value={about}
                maxLength={2000}
                onChange={(event) => setAbout(event.target.value)}
              />
              <p className="form-help">
                Deskripsi singkat organisasi Anda (maksimal 2000 karakter).
              </p>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-profile-contact-name">
                Nama narahubung
              </label>
              <input
                id="institution-profile-contact-name"
                className="form-input"
                value={contactName}
                maxLength={160}
                onChange={(event) => setContactName(event.target.value)}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-profile-contact-email">
                Email narahubung
              </label>
              <input
                id="institution-profile-contact-email"
                className="form-input"
                type="email"
                value={contactEmail}
                maxLength={254}
                onChange={(event) => setContactEmail(event.target.value)}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-profile-contact-phone">
                Telepon narahubung
              </label>
              <input
                id="institution-profile-contact-phone"
                className="form-input"
                value={contactPhone}
                maxLength={40}
                onChange={(event) => setContactPhone(event.target.value)}
              />
            </div>

            <fieldset className="form-field">
              <legend className="form-label">Tautan sosial</legend>
              {SOCIAL_PLATFORMS.map(({ platform, label, placeholder }) => (
                <div className="form-field" key={platform}>
                  <label className="form-label" htmlFor={`institution-profile-social-${platform}`}>
                    {label}
                  </label>
                  <input
                    id={`institution-profile-social-${platform}`}
                    className="form-input"
                    type="url"
                    value={socials[platform]}
                    placeholder={placeholder}
                    maxLength={2048}
                    onChange={(event) =>
                      setSocials((prev) => ({ ...prev, [platform]: event.target.value }))
                    }
                  />
                </div>
              ))}
              <p className="form-help">Kosongkan tautan yang tidak ingin ditampilkan.</p>
            </fieldset>
          </form>
        )}
      </section>

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Pengaturan institusi"
          onClick={() => router.push(`/institution/${institutionSlug}/settings`)}
        />
        {!isLoading && isEditable ? (
          <div className="form-action-bar-end">
            <Button
              type="button"
              onClick={() => onSubmit()}
              loading={isSaving}
              leadingIcon={<Icon name="save" />}
            >
              Simpan profil
            </Button>
          </div>
        ) : null}
      </FormActionBar>
    </main>
  );
};
