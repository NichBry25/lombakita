"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BarNote,
  Button,
  FormActionBar,
  FormHelp,
  FormInput,
  FormLabel,
  FormLabelText,
  FormTextarea,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
  usePageTransition,
} from "@/components/ui";
import { useModal, useToast, type ModalOutcome } from "@/components/ui/primitives";
import {
  InstitutionBannerUpload,
  InstitutionLogoUpload,
} from "@/components/institution/institution-media-controls";
import { PaymentInstructionsSection } from "@/components/institution/payment-instructions-section";
import { INSTITUTION_TYPE_LABELS } from "@/lib/institutions/type-labels";
import { INSTITUTION_STATUS_LABELS } from "@/lib/institutions/status-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { hasUnsavedFields } from "@/lib/ui/unsaved-fields";
import type { InstitutionType } from "@/server/db/schema";
import type { TickPath } from "@/server/institution-verification/tick-transition";

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
  };
};

const emptySocials = (): Record<SocialPlatform, string> => ({
  linkedin: "",
  github: "",
  instagram: "",
  x: "",
  website: "",
});

type RefusalAction = "load" | "identity" | "profile";

const INVALID_PAYLOAD_MESSAGE =
  "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.";
const TICK_REMOVAL_UNCONFIRMED_MESSAGE =
  "Perubahan ini mencabut centang. Setujui peringatannya dulu.";

const REFUSAL_COPY: Record<RefusalAction, Partial<Record<string, string>>> = {
  load: {
    institution_invalid_value: "Institusi tidak ditemukan. Periksa tautan lalu coba lagi.",
    forbidden: "Hanya pemilik institusi yang dapat membuka pengaturan ini.",
  },
  identity: {
    forbidden: "Hanya pemilik institusi yang dapat mengubah pengaturan ini.",
    institution_invalid_payload: INVALID_PAYLOAD_MESSAGE,
    institution_protected_fields: INVALID_PAYLOAD_MESSAGE,
    institution_invalid_fields: INVALID_PAYLOAD_MESSAGE,
    institution_invalid_value: "Periksa nama institusi dan slug lalu coba lagi.",
    institution_display_name_reserved: "Nama institusi ini tidak dapat digunakan. Pilih nama lain.",
    institution_slug_reserved: "Slug ini tidak dapat digunakan. Pilih slug lain.",
    institution_slug_conflicts_with_username:
      "Slug ini sudah dipakai sebagai username. Pilih slug lain.",
    institution_tick_removal_unconfirmed: TICK_REMOVAL_UNCONFIRMED_MESSAGE,
  },
  profile: {
    forbidden: "Hanya pemilik institusi yang dapat mengubah profil penyelenggara.",
    institution_profile_invalid_payload: INVALID_PAYLOAD_MESSAGE,
    institution_profile_invalid_fields: INVALID_PAYLOAD_MESSAGE,
    institution_profile_invalid_value:
      "Periksa kontak, situs web, dan tautan media sosial lalu coba lagi.",
    institution_tick_removal_unconfirmed: TICK_REMOVAL_UNCONFIRMED_MESSAGE,
  },
};

const TICK_REMOVAL_UNCONFIRMED_CODE = "institution_tick_removal_unconfirmed";

const TICK_REMOVAL_WARNING_TITLE = "Centang akan dicabut";
const TICK_REMOVAL_WARNING_CONSEQUENCE =
  "Selama itu, kompetisi berbayar baru tidak dapat diterbitkan dan peserta kompetisi berbayar yang sedang berjalan tidak dapat membayar.";
const WEBSITE_TICK_REMOVAL_BODY = `Mengganti situs web ruang kerja yang terverifikasi mencabut centangnya sampai lolos pemeriksaan lagi. ${TICK_REMOVAL_WARNING_CONSEQUENCE}`;
const NAME_TICK_REMOVAL_BODY = `Nama baru berbeda dari nama yang sudah diperiksa, jadi ruang kerja ini kehilangan centangnya. ${TICK_REMOVAL_WARNING_CONSEQUENCE}`;
const INSTAGRAM_BIO_NOTE = "Perbarui juga tautan di bio Instagram Anda ke alamat baru.";

const REFUSAL_FALLBACK: Record<RefusalAction, string> = {
  load: "Pengaturan institusi gagal dimuat. Muat ulang halaman lalu coba lagi.",
  identity: "Pengaturan institusi gagal disimpan. Coba lagi.",
  profile: "Gagal menyimpan profil. Coba lagi.",
};

export const InstitutionSettingsShell = ({
  institutionSlug,
  expectedUserId,
  tickPath,
}: {
  institutionSlug: string;
  expectedUserId: string;
  tickPath: TickPath | null;
}) => {
  const router = useRouter();
  const { begin: beginPageTransition } = usePageTransition();
  const { addToast } = useToast();
  const { openModal } = useModal();
  const [activeSlug, setActiveSlug] = useState(institutionSlug);

  // Identity — the page's primary form, saved from the sticky action bar (§13.1 group 2).
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<"active" | "inactive" | "suspended">("inactive");
  const [institutionType, setInstitutionType] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  // What the server last returned for the identity form. The bar's Simpan saves only these two
  // fields, so only they decide whether the bar says "Belum disimpan".
  const [savedIdentity, setSavedIdentity] = useState({ displayName: "", slug: "" });
  const hasUnsavedChanges = hasUnsavedFields({ displayName, slug }, savedIdentity);

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
  // The organizer profile section renders once the profile read succeeds.
  const [hasProfile, setHasProfile] = useState(false);

  const applyInstitution = useCallback((data: InstitutionSettingsResponse) => {
    setDisplayName(data.institution.displayName);
    setSlug(data.institution.slug);
    setSavedIdentity({
      displayName: data.institution.displayName,
      slug: data.institution.slug,
    });
    setStatus(data.institution.status);
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
      const code = await readErrorCode(response);
      addToast({
        type: "error",
        message: errorMessageFor(code, REFUSAL_COPY.load, REFUSAL_FALLBACK.load),
      });
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
      setHasProfile(true);
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

  const openTickRemovalWarning = (warning: {
    body: string;
    confirmLabel: string;
    confirmChange: () => Promise<ModalOutcome>;
  }) => {
    openModal({
      title: TICK_REMOVAL_WARNING_TITLE,
      body: warning.body,
      alert: true,
      actions: [
        { label: "Batal" },
        { label: warning.confirmLabel, variant: "primary", onClick: warning.confirmChange },
      ],
    });
  };

  // `description` is deliberately not sent: the organizer profile's `about` replaced it as the
  // authored blurb, and omitting the key preserves whatever is stored.
  const sendIdentityPatch = (options: { acknowledgeTickRemoval: boolean }) =>
    sessionFetch(
      expectedUserId,
      `/api/v1/institutions/${encodeURIComponent(activeSlug)}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          options.acknowledgeTickRemoval
            ? { displayName, slug, acknowledgeTickRemoval: true }
            : { displayName, slug },
        ),
      },
    );

  const finishIdentitySave = async (response: Response) => {
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

  const confirmIdentityChange = async (): Promise<ModalOutcome> => {
    let response: Response;
    try {
      response = await sendIdentityPatch({ acknowledgeTickRemoval: true });
    } catch {
      return { ok: false, message: NETWORK_ERROR_MESSAGE };
    }

    if (!response.ok) {
      const code = await readErrorCode(response);
      return {
        ok: false,
        message: errorMessageFor(code, REFUSAL_COPY.identity, REFUSAL_FALLBACK.identity),
      };
    }

    await finishIdentitySave(response);
    return { ok: true };
  };

  const saveIdentity = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    if (displayName.trim().length < 2) {
      addToast({ type: "error", message: "Nama institusi minimal terdiri dari 2 karakter." });
      return;
    }

    if (slug.trim().length < 3) {
      addToast({ type: "error", message: "Slug minimal terdiri dari 3 karakter." });
      return;
    }

    setIsSaving(true);

    const response = await sendIdentityPatch({ acknowledgeTickRemoval: false });

    if (!response.ok) {
      const code = await readErrorCode(response);
      setIsSaving(false);
      if (code === TICK_REMOVAL_UNCONFIRMED_CODE) {
        openTickRemovalWarning({
          body: NAME_TICK_REMOVAL_BODY,
          confirmLabel: "Ganti nama dan cabut centang",
          confirmChange: confirmIdentityChange,
        });
        return;
      }
      addToast({
        type: "error",
        message: errorMessageFor(code, REFUSAL_COPY.identity, REFUSAL_FALLBACK.identity),
      });
      return;
    }

    await finishIdentitySave(response);
  };

  const sendProfilePatch = (options: { acknowledgeTickRemoval: boolean }) => {
    const socialLinks = SOCIAL_PLATFORMS.map(({ platform }) => ({
      platform,
      url: socials[platform].trim(),
    })).filter((link) => link.url.length > 0);
    const body = {
      about,
      contactName,
      contactEmail,
      contactPhone,
      websiteUrl: socials.website,
      socialLinks,
    };

    return sessionFetch(
      expectedUserId,
      `/api/v1/institutions/${encodeURIComponent(activeSlug)}/profile`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          options.acknowledgeTickRemoval ? { ...body, acknowledgeTickRemoval: true } : body,
        ),
      },
    );
  };

  const confirmProfileChange = async (): Promise<ModalOutcome> => {
    let response: Response;
    try {
      response = await sendProfilePatch({ acknowledgeTickRemoval: true });
    } catch {
      return { ok: false, message: NETWORK_ERROR_MESSAGE };
    }

    if (!response.ok) {
      const code = await readErrorCode(response);
      return {
        ok: false,
        message: errorMessageFor(code, REFUSAL_COPY.profile, REFUSAL_FALLBACK.profile),
      };
    }

    addToast({ type: "success", message: "Profil penyelenggara berhasil disimpan." });
    return { ok: true };
  };

  const saveProfile = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isSavingProfile) return;
    setIsSavingProfile(true);

    try {
      const response = await sendProfilePatch({ acknowledgeTickRemoval: false });

      if (!response.ok) {
        const code = await readErrorCode(response);
        if (code === TICK_REMOVAL_UNCONFIRMED_CODE) {
          openTickRemovalWarning({
            body: WEBSITE_TICK_REMOVAL_BODY,
            confirmLabel: "Simpan dan cabut centang",
            confirmChange: confirmProfileChange,
          });
          return;
        }
        addToast({
          type: "error",
          message: errorMessageFor(code, REFUSAL_COPY.profile, REFUSAL_FALLBACK.profile),
        });
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
        titleMark={
          institutionType ? (
            <span className="status-badge">
              {INSTITUTION_TYPE_LABELS[institutionType as InstitutionType] ??
                formatDisplayToken(institutionType)}
            </span>
          ) : null
        }
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
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
              <FormLabel htmlFor="institution-settings-display-name" required>
                Nama institusi
              </FormLabel>
              <FormInput
                id="institution-settings-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </div>

            <div className="form-field">
              <FormLabel htmlFor="institution-settings-slug" required>
                Slug
              </FormLabel>
              <FormInput
                id="institution-settings-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                required
              />
              {tickPath === "instagram" && slug !== savedIdentity.slug ? (
                <FormHelp>{INSTAGRAM_BIO_NOTE}</FormHelp>
              ) : null}
            </div>

            <div className="form-field">
              <FormLabel htmlFor="institution-settings-status">Status awal platform</FormLabel>
              <FormInput
                id="institution-settings-status"
                value={INSTITUTION_STATUS_LABELS[status]}
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
              <FormLabelText optional>Logo</FormLabelText>
              <InstitutionLogoUpload
                expectedUserId={expectedUserId}
                institutionSlug={activeSlug}
                currentUrl={logoUrl}
              />
            </div>

            <div className="form-field">
              <FormLabelText optional>Sampul</FormLabelText>
              <InstitutionBannerUpload
                expectedUserId={expectedUserId}
                institutionSlug={activeSlug}
                currentUrl={bannerUrl}
              />
            </div>

            <div className="form-field">
              <FormLabel htmlFor="institution-profile-about" optional>
                Tentang
              </FormLabel>
              <FormTextarea
                id="institution-profile-about"
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
              <FormLabel htmlFor="institution-profile-contact-name" optional>
                Nama Narahubung
              </FormLabel>
              <FormInput
                id="institution-profile-contact-name"
                value={contactName}
                maxLength={160}
                onChange={(event) => setContactName(event.target.value)}
              />
            </div>

            <div className="form-field">
              <FormLabel htmlFor="institution-profile-contact-email" optional>
                Email Narahubung
              </FormLabel>
              <FormInput
                id="institution-profile-contact-email"
                type="email"
                value={contactEmail}
                maxLength={254}
                onChange={(event) => setContactEmail(event.target.value)}
              />
            </div>

            <div className="form-field">
              <FormLabel htmlFor="institution-profile-contact-phone" optional>
                Telepon Narahubung
              </FormLabel>
              <FormInput
                id="institution-profile-contact-phone"
                value={contactPhone}
                maxLength={40}
                onChange={(event) => setContactPhone(event.target.value)}
              />
            </div>

            <fieldset className="form-field">
              {SOCIAL_PLATFORMS.map(({ platform, label, placeholder }) => (
                <div className="form-field" key={platform}>
                  <FormLabel htmlFor={`institution-profile-social-${platform}`} optional>
                    {label}
                  </FormLabel>
                  <FormInput
                    id={`institution-profile-social-${platform}`}
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

      {/* Its own endpoint and its own Save, so it sits outside the page's global Save. Rendered
          after the profile section because it is administrative rather than public-facing. */}
      {!isLoading ? (
        <PaymentInstructionsSection institutionSlug={activeSlug} expectedUserId={expectedUserId} />
      ) : null}

      <FormActionBar>
        <IconButton
          variant="plain"
          size="back"
          icon="arrow-left"
          label="Kembali"
          onClick={() => router.push(`/institution/${activeSlug}`)}
        />
        {!isLoading ? (
          <div className="form-action-bar-end">
            {hasUnsavedChanges ? <BarNote>Belum disimpan</BarNote> : null}
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
