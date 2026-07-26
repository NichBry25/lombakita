"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  FormActionBar,
  IconButton,
  PageHeader,
  SelectField,
} from "@/components/ui";
// Type-only: importing the enum VALUE would pull the Drizzle schema into the client bundle. The
// exhaustive Record below is the compile-time guarantee instead — a new full subtype fails to build
// until it is given a label here.
import type { FullInstitutionType } from "@/server/institution-workspace/institution-type";

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

const TYPE_LABELS: Record<FullInstitutionType, string> = {
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({
  value: value as FullInstitutionType,
  label,
}));

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
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [institutionType, setInstitutionType] = useState<FullInstitutionType>("company");
  const [isCreating, setIsCreating] = useState(false);
  const [createdInstitutionSlug, setCreatedInstitutionSlug] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const onSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

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
      institutionType: FullInstitutionType;
    } = {
      displayName,
      institutionType,
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
      message: "Institusi berhasil dibuat. Lanjutkan ke pengaturan.",
    });
    setIsCreating(false);
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        eyebrow="Institusi baru"
        title="Buat institusi"
        description="Tetapkan identitas dasar ruang penyelenggara. Slug dapat dikosongkan agar dibuat otomatis."
      />

      <section className="content-section">
        <form className="stack-md" onSubmit={onSubmit}>
          <div className="form-field">
            <label className="form-label" htmlFor="institution-display-name">
              Nama institusi
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
            <SelectField
              id="institution-type"
              label="Tipe institusi"
              value={institutionType}
              onChange={(value) => setInstitutionType(value as FullInstitutionType)}
              options={TYPE_OPTIONS}
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

          {createdInstitutionSlug ? (
            <div className="record-actions">
              <ButtonLink
                href={`/institution/${createdInstitutionSlug}/settings`}
                prefetch={false}
                variant="outline"
              >
                Buka pengaturan
              </ButtonLink>
            </div>
          ) : null}
        </form>
      </section>

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Dasbor rekruter"
          onClick={() => router.push("/recruiter-dashboard")}
        />
        <div className="form-action-bar-end">
          <Button type="button" onClick={() => onSubmit()} loading={isCreating}>
            Buat workspace
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
