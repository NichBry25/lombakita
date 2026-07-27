"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  FormActionBar,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
  usePageTransition,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { formatDisplayToken } from "@/lib/text/capitalize";

// User-facing pill label per institution type. Single-word values are capitalized (§13.3); the
// pill shows just the type ("Personal", "Perusahaan", …) with no "Tipe " prefix.
const INSTITUTION_TYPE_LABELS: Record<string, string> = {
  personal: "Personal",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

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

export const InstitutionSettingsShell = ({ institutionSlug }: { institutionSlug: string }) => {
  const router = useRouter();
  const { begin: beginPageTransition } = usePageTransition();
  const { addToast } = useToast();
  const [activeSlug, setActiveSlug] = useState(institutionSlug);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"active" | "inactive" | "suspended">("inactive");
  // Step 6.5f.1 — a personal institution's name is derived from the owner username and is read-only;
  // the type also drives the minimal "Personal" indicator in the header.
  const [isPersonal, setIsPersonal] = useState(false);
  const [institutionType, setInstitutionType] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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

    const data = (await response.json()) as InstitutionSettingsResponse;

    setDisplayName(data.institution.displayName);
    setSlug(data.institution.slug);
    setDescription(data.institution.description ?? "");
    setStatus(data.institution.status);
    setIsPersonal(data.institution.institutionType === "personal");
    setInstitutionType(data.institution.institutionType);
    setIsLoading(false);
  }, [activeSlug, addToast]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadInstitution();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadInstitution]);

  const onSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
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

    // Description is editable for every type; name/slug only for full institutions (personal derives
    // both from the owner username). Empty description clears the stored value (null).
    const trimmedDescription = description.trim();
    const body: { displayName?: string; slug: string; description: string | null } = {
      slug,
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
    };
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

    setDisplayName(data.institution.displayName);
    setSlug(nextSlug);
    setDescription(data.institution.description ?? "");
    setStatus(data.institution.status);
    setIsPersonal(data.institution.institutionType === "personal");
    setInstitutionType(data.institution.institutionType);
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

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        eyebrow="Identitas workspace"
        title="Pengaturan institusi"
        description="Kelola nama, slug, deskripsi, dan status dasar institusi."
        actions={
          institutionType ? (
            <span className="status-badge">
              {INSTITUTION_TYPE_LABELS[institutionType] ?? formatDisplayToken(institutionType)}
            </span>
          ) : undefined
        }
      />

      <section className="content-section">
        {isLoading ? (
          <div className="stack-md" aria-label="Memuat data institusi">
            <Skeleton variant="title" />
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : (
          <form className="stack-md" onSubmit={onSubmit}>
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
              <label className="form-label" htmlFor="institution-settings-description">
                Deskripsi
              </label>
              <textarea
                id="institution-settings-description"
                className="form-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                maxLength={500}
                placeholder="Deskripsi singkat institusi (Opsional)."
              />
              <p className="form-help">
                Deskripsi singkat yang tampil pada daftar institusi Anda. Maksimal 500 karakter.
              </p>
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

      {!isPersonal ? (
        <div className="page-secondary-actions">
          <ButtonLink
            href={`/institution/${activeSlug}/settings/profile`}
            prefetch={false}
            variant="outline"
            size="sm"
          >
            Profil penyelenggara
          </ButtonLink>
        </div>
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
              onClick={() => onSubmit()}
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
