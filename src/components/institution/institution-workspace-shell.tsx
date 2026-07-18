"use client";

import { useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button, ButtonLink, PageHeader } from "@/components/ui";

type InstitutionCreationResponse = {
  institution: {
    institutionId: string;
    displayName: string;
    slug: string;
    status: "active" | "inactive" | "suspended";
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

    return payload.error?.message ?? "Permintaan workspace institusi gagal diproses.";
  } catch {
    return "Permintaan workspace institusi gagal diproses.";
  }
};

export const InstitutionWorkspaceShell = () => {
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createdInstitutionSlug, setCreatedInstitutionSlug] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setFeedback(null);

    if (displayName.trim().length < 2) {
      setFeedback({
        type: "error",
        message: "Nama institusi minimal terdiri dari 2 karakter.",
      });
      return;
    }

    setIsCreating(true);

    const payload: {
      displayName: string;
      slug?: string;
    } = {
      displayName,
    };

    if (slug.trim().length > 0) {
      payload.slug = slug;
    }

    const response = await fetch("/api/v1/institutions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);

      setFeedback({
        type: "error",
        message,
      });
      setIsCreating(false);
      return;
    }

    const data = (await response.json()) as InstitutionCreationResponse;
    const nextSlug = data.institution.slug;

    setCreatedInstitutionSlug(nextSlug);
    setFeedback({
      type: "success",
      message: "Workspace institusi berhasil dibuat. Lanjutkan ke pengaturan institusi.",
    });
    setIsCreating(false);
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        eyebrow="Workspace baru"
        title="Buat workspace institusi"
        description="Tetapkan identitas dasar ruang penyelenggara. Slug dapat dikosongkan agar dibuat otomatis."
        backHref="/recruiter-dashboard"
        backLabel="Dasbor rekruter"
      />

      <section className="content-section">
        <form className="stack-md" onSubmit={onSubmit}>
          <div className="form-field">
            <label className="form-label" htmlFor="institution-display-name">
              Nama Institusi
            </label>
            <input
              id="institution-display-name"
              className="form-input"
              autoComplete="organization"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Contoh: Universitas Nusantara"
              required
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="institution-slug">
              Slug (opsional)
            </label>
            <input
              id="institution-slug"
              className="form-input"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="universitas-nusantara"
            />
          </div>

          {feedback ? (
            <p className="feedback" data-tone={feedback.type} role="status">
              {feedback.message}
            </p>
          ) : null}

          <div className="record-actions">
            <Button type="submit" disabled={isCreating} loading={isCreating}>
              {isCreating ? "Menyimpan..." : "Buat Workspace"}
            </Button>

            {createdInstitutionSlug ? (
              <ButtonLink
                href={`/institution/${createdInstitutionSlug}/settings`}
                prefetch={false}
                variant="outline"
              >
                Buka pengaturan
              </ButtonLink>
            ) : null}
          </div>
        </form>
      </section>

      <div className="page-secondary-actions">
        <SignOutButton />
        <ButtonLink href="/" prefetch={false} variant="ghost" size="sm">
          Kembali ke beranda
        </ButtonLink>
      </div>
    </main>
  );
};
