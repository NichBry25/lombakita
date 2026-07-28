"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  FormActionBar,
  IconButton,
  PageHeader,
  SelectField,
  usePageTransition,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
// Type-only: importing the enum VALUE would pull the Drizzle schema into the client bundle. The
// exhaustive Record below is the compile-time guarantee instead — a new full subtype fails to build
// until it is given a label here.
import type { FullInstitutionType } from "@/server/institution-workspace/institution-type";

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

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        message?: string;
      };
    };

    return payload.error?.message ?? "Permintaan ruang kerja institusi gagal diproses.";
  } catch {
    return "Permintaan ruang kerja institusi gagal diproses.";
  }
};

export const InstitutionWorkspaceShell = () => {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [institutionType, setInstitutionType] = useState<FullInstitutionType>("company");
  const [isCreating, setIsCreating] = useState(false);
  const { addToast } = useToast();
  const { runAndNavigate } = usePageTransition();

  const onSubmit = (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    return runAndNavigate(createInstitution, { message: "Membuat institusi…" });
  };

  // Returns whether a navigation was started, so a rejected create drops the blocking screen
  // instead of leaving the user staring at it.
  const createInstitution = async (): Promise<boolean> => {
    if (displayName.trim().length < 2) {
      addToast({ type: "error", message: "Nama institusi minimal terdiri dari 2 karakter." });
      return false;
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

      addToast({ type: "error", message });
      setIsCreating(false);
      return false;
    }

    addToast({ type: "success", message: "Institusi berhasil dibuat." });
    setIsCreating(false);
    router.replace("/recruiter-dashboard");
    return true;
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        title="Buat institusi"
        description="Isi identitas institusi. Slug bisa dikosongkan — kami buatkan otomatis."
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
              Slug (Opsional)
            </label>
            <input
              id="institution-slug"
              className="form-input"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="universitas-nusantara"
            />
          </div>
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
            Buat institusi
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
