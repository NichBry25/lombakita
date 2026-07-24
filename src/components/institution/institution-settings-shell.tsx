"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";
import {
  Button,
  ButtonLink,
  FormActionBar,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { formatDisplayToken } from "@/lib/text/capitalize";

type InstitutionSettingsResponse = {
  institution: {
    institutionId: string;
    displayName: string;
    slug: string;
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

type FeedbackState =
  | {
      type: "success";
      message: string;
    }
  | {
      type: "error";
      message: string;
    }
  | null;

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
  const [activeSlug, setActiveSlug] = useState(institutionSlug);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<"active" | "inactive" | "suspended">("inactive");
  // Step 6.5f.1 — a personal institution's name is derived from the owner username and is read-only;
  // the type also drives the minimal "Personal" indicator in the header.
  const [isPersonal, setIsPersonal] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const loadInstitution = useCallback(async () => {
    setIsLoading(true);
    setFeedback(null);

    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(activeSlug)}/settings`,
      {
        cache: "no-store",
        credentials: "include",
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({
        type: "error",
        message,
      });
      setIsLoading(false);
      return;
    }

    const data = (await response.json()) as InstitutionSettingsResponse;

    setDisplayName(data.institution.displayName);
    setSlug(data.institution.slug);
    setStatus(data.institution.status);
    setIsPersonal(data.institution.institutionType === "personal");
    setIsLoading(false);
  }, [activeSlug]);

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
      setFeedback({
        type: "error",
        message: "Nama institusi minimal terdiri dari 2 karakter.",
      });
      return;
    }

    if (slug.trim().length < 3) {
      setFeedback({
        type: "error",
        message: "Slug minimal terdiri dari 3 karakter.",
      });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(activeSlug)}/settings`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(isPersonal ? { slug } : { displayName, slug }),
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);

      setFeedback({
        type: "error",
        message,
      });
      setIsSaving(false);
      return;
    }

    const data = (await response.json()) as InstitutionSettingsResponse;
    const nextSlug = data.institution.slug;

    setDisplayName(data.institution.displayName);
    setSlug(nextSlug);
    setStatus(data.institution.status);
    setIsPersonal(data.institution.institutionType === "personal");
    setFeedback({
      type: "success",
      message: "Pengaturan institusi berhasil disimpan.",
    });
    setIsSaving(false);

    if (nextSlug !== activeSlug) {
      setActiveSlug(nextSlug);
      router.replace(`/institution/${nextSlug}/settings`);
    }
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        eyebrow="Identitas workspace"
        title="Pengaturan institusi"
        description="Kelola nama, slug, dan status dasar institusi."
        actions={isPersonal ? <span className="status-badge">Tipe personal</span> : undefined}
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

            {feedback ? (
              <p className="feedback" data-tone={feedback.type} role="status">
                {feedback.message}
              </p>
            ) : null}
          </form>
        )}
      </section>

      <div className="page-secondary-actions">
        {!isPersonal ? (
          <ButtonLink
            href={`/institution/${activeSlug}/settings/profile`}
            prefetch={false}
            variant="outline"
            size="sm"
          >
            Profil penyelenggara
          </ButtonLink>
        ) : null}
        <SignOutButton />
        <ButtonLink href="/institution/workspace" prefetch={false} variant="ghost" size="sm">
          Buat workspace lain
        </ButtonLink>
        <ButtonLink href="/" prefetch={false} variant="ghost" size="sm">
          Kembali ke beranda
        </ButtonLink>
      </div>

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
              disabled={isSaving}
              loading={isSaving}
              leadingIcon={<Icon name="save" />}
            >
              {isSaving ? "Menyimpan..." : "Simpan perubahan"}
            </Button>
          </div>
        ) : null}
      </FormActionBar>
    </main>
  );
};
