"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  FormActionBar,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
  usePageTransition,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  InstitutionBannerUpload,
  InstitutionLogoUpload,
} from "@/components/institution/institution-media-controls";
import { formatDisplayToken } from "@/lib/text/capitalize";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

// User-facing pill label per institution type. Single-word values are capitalized (§13.3); the
// pill shows just the type ("Personal", "Perusahaan", …) with no "Tipe " prefix.
const INSTITUTION_TYPE_LABELS: Record<string, string> = {
  personal: "Personal",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

type SocialPlatform = "linkedin" | "github" | "instagram" | "x" | "website";

const SOCIAL_PLATFORMS: Array<{ platform: SocialPlatform; label: string; placeholder: string }> = [
  { platform: "website", label: "Website", placeholder: "https://institusi.ac.id" },
  { platform: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/company/…" },
  { platform: "instagram", label: "Instagram", placeholder: "https://instagram.com/…" },
  { platform: "x", label: "X (Twitter)", placeholder: "https://x.com/…" },
  { platform: "github", label: "GitHub", placeholder: "https://github.com/…" },
];

type InstitutionSettingsResponse = {
  institution: {
    institutionId: string;
    displayName: string;
    slug: string;
    description: string | null;
    status: "active" | "inactive" | "suspended";
    institutionType: string | null;
    ownerMembership: {
      membershipId: string;
      membershipRole: "institution_owner" | "institution_staff" | "institution_member";
      membershipStatus: "invited" | "active" | "inactive" | "revoked";
      joinedAt: string;
    };
    createdAt: string;
    updatedAt: string;
  };
};

type ProfileResponse = {
  profile: {
    about: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    websiteUrl: string | null;
    logoUrl: string | null;
    bannerUrl: string | null;
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

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        message?: string;
      };
    };

    return payload.error?.message ?? "Permintaan pengaturan institusi gagal diproses.";
  } catch {
    return "Permintaan pengaturan institusi gagal diproses.";
  }
};

const extractSessionAwareErrorMessage = async (
  response: Response,
  fallback: string,
): Promise<string> => {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;

  if (body?.error?.code === SESSION_MISMATCH_CODE) {
    return SESSION_MISMATCH_MESSAGE;
  }

  return body?.error?.message ?? fallback;
};

export const InstitutionSettingsShell = ({
  institutionSlug,
  expectedUserId,
}: {
  institutionSlug: string;
  expectedUserId: string;
}) => {
  const router = useRouter();
  const { begin: beginPageTransition } = usePageTransition();
  const { addToast } = useToast();
  const [activeSlug, setActiveSlug] = useState(institutionSlug);

  // Identity — the page's primary form, saved from the sticky action bar (§13.1 group 2).
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<"active" | "inactive" | "suspended">("inactive");
  // A personal institution's name is derived from the owner username and is read-only;
  // the type also drives the minimal "Personal" indicator in the header.
  const [isPersonal, setIsPersonal] = useState(false);
  const [institutionType, setInstitutionType] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Public organizer profile — an independent sub-form with its own Save (§13.1 group 1).
  const [about, setAbout] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [socials, setSocials] = useState<Record<SocialPlatform, string>>(emptySocials());
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  // A personal institution has no public organizer profile, so the whole section is withheld.
  const [hasProfile, setHasProfile] = useState(false);

  const applyInstitution = useCallback((data: InstitutionSettingsResponse) => {
    setDisplayName(data.institution.displayName);
    setSlug(data.institution.slug);
    setStatus(data.institution.status);
    setIsPersonal(data.institution.institutionType === "personal");
    setInstitutionType(data.institution.institutionType);
  }, []);

  const loadInstitution = useCallback(async () => {
    setIsLoading(true);

    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(activeSlug)}/settings`,
      {
        cache: "no-store",
        credentials: "include",
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      setIsLoading(false);
      return;
    }

    applyInstitution((await response.json()) as InstitutionSettingsResponse);
    setIsLoading(false);
  }, [activeSlug, addToast, applyInstitution]);

  const loadProfile = useCallback(async () => {
    setIsProfileLoading(true);
    try {
      const response = await fetch(
        `/api/v1/institutions/${encodeURIComponent(activeSlug)}/profile`,
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
      setLogoUrl(profile.logoUrl);
      setBannerUrl(profile.bannerUrl);
      setHasProfile(profile.isEditable);
    } catch {
      addToast({ type: "error", message: "Gagal memuat profil penyelenggara." });
    } finally {
      setIsProfileLoading(false);
    }
  }, [activeSlug, addToast]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadInstitution();
      void loadProfile();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadInstitution, loadProfile]);

  const saveIdentity = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    // A personal institution has no editable name (it derives from the owner username), so the name
    // length check is skipped and only the slug is sent.
    if (!isPersonal && displayName.trim().length < 2) {
      addToast({ type: "error", message: "Nama institusi minimal terdiri dari 2 karakter." });
      return;
    }

    if (slug.trim().length < 3) {
      addToast({ type: "error", message: "Slug minimal terdiri dari 3 karakter." });
      return;
    }

    setIsSaving(true);

    // Name/slug are editable only for full institutions — a personal institution derives both from
    // the owner username. `description` is deliberately not sent: the organizer profile's `about`
    // replaced it as the authored blurb, and omitting the key preserves whatever is stored.
    const body: { displayName?: string; slug: string } = { slug };
    if (!isPersonal) {
      body.displayName = displayName;
    }

    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(activeSlug)}/settings`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      setIsSaving(false);
      return;
    }

    const data = (await response.json()) as InstitutionSettingsResponse;
    const nextSlug = data.institution.slug;

    applyInstitution(data);
    addToast({ type: "success", message: "Pengaturan institusi berhasil disimpan." });
    setIsSaving(false);

    // A renamed institution moves to a new URL. Only that branch is a page change, so the
    // blocking screen is raised here rather than at submit time.
    if (nextSlug !== activeSlug) {
      setActiveSlug(nextSlug);
      beginPageTransition("Memindahkan ke alamat baru…");
      router.replace(`/institution/${nextSlug}/settings`);
    }
  };

  const saveProfile = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isSavingProfile) return;
    setIsSavingProfile(true);

    const socialLinks = SOCIAL_PLATFORMS.map(({ platform }) => ({
      platform,
      url: socials[platform].trim(),
    })).filter((link) => link.url.length > 0);

    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/institutions/${encodeURIComponent(activeSlug)}/profile`,
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
        const message = await extractSessionAwareErrorMessage(
          response,
          "Gagal menyimpan profil. Coba lagi.",
        );
        addToast({ type: "error", message });
        return;
      }

      addToast({ type: "success", message: "Profil penyelenggara berhasil disimpan." });
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan profil karena gangguan koneksi." });
    } finally {
      setIsSavingProfile(false);
    }
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        title="Pengaturan institusi"
        description="Kelola identitas institusi dan profil penyelenggara yang tampil ke publik."
        actions={
          institutionType ? (
            <span className="status-badge">
              {INSTITUTION_TYPE_LABELS[institutionType] ?? formatDisplayToken(institutionType)}
            </span>
          ) : undefined
        }
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Identitas</p>
            <h2>Identitas institusi</h2>
          </div>
        </div>
        {isLoading ? (
          <div className="stack-md" aria-label="Memuat data institusi">
            <Skeleton variant="title" />
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : (
          <form className="stack-md" onSubmit={saveIdentity}>
            <div className="form-field">
              <label className="form-label" htmlFor="institution-settings-display-name">
                Nama institusi
              </label>
              <input
                id="institution-settings-display-name"
                className={isPersonal ? "form-input form-input-readonly" : "form-input"}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                readOnly={isPersonal}
                required={!isPersonal}
              />
              {isPersonal ? (
                <p className="form-help">
                  Nama institusi personal mengikuti username Anda dan tidak dapat diubah di sini.
                </p>
              ) : null}
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-settings-slug">
                Slug
              </label>
              <input
                id="institution-settings-slug"
                className={isPersonal ? "form-input form-input-readonly" : "form-input"}
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                readOnly={isPersonal}
                required={!isPersonal}
              />
              {isPersonal ? (
                <p className="form-help">
                  Slug institusi personal mengikuti username Anda dan tidak dapat diubah di sini.
                  Ubah username Anda di pengaturan profil untuk mengubahnya.
                </p>
              ) : null}
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-settings-status">
                Status awal platform
              </label>
              <input
                id="institution-settings-status"
                className="form-input form-input-readonly"
                value={formatDisplayToken(status)}
                readOnly
              />
            </div>
          </form>
        )}
      </section>

      {isProfileLoading ? (
        <section className="content-section">
          <div className="stack-md" aria-label="Memuat profil penyelenggara">
            <Skeleton variant="title" />
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        </section>
      ) : hasProfile ? (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <h2>Profil penyelenggara</h2>
            </div>
          </div>
          <p className="muted-copy">
            Informasi ini tampil di halaman kompetisi yang Anda selenggarakan.
          </p>

          <form className="stack-md" onSubmit={saveProfile}>
            <div className="form-field">
              <span className="form-label">Logo</span>
              <InstitutionLogoUpload
                expectedUserId={expectedUserId}
                institutionSlug={activeSlug}
                currentUrl={logoUrl}
              />
            </div>

            <div className="form-field">
              <span className="form-label">Sampul</span>
              <InstitutionBannerUpload
                expectedUserId={expectedUserId}
                institutionSlug={activeSlug}
                currentUrl={bannerUrl}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-profile-about">
                Tentang
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
                Nama Narahubung
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
                Email Narahubung
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
                Telepon Narahubung
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

            <div className="cluster">
              <Button type="submit" loading={isSavingProfile} leadingIcon={<Icon name="save" />}>
                Simpan profil
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Panel institusi"
          onClick={() => router.push(`/institution/${activeSlug}`)}
        />
        {!isLoading ? (
          <div className="form-action-bar-end">
            <Button
              type="button"
              onClick={() => saveIdentity()}
              loading={isSaving}
              leadingIcon={<Icon name="save" />}
            >
              Simpan
            </Button>
          </div>
        ) : null}
      </FormActionBar>
    </main>
  );
};
