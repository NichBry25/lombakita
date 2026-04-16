"use client";

import Link from "next/link";
import { useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";

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
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-14">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-gleam">Buat Workspace Institusi</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Proof surface Step 2.2 untuk membuat tenant institusi dan owner awal.
        </p>
      </header>

      <section className="glass-card p-6">
        <form className="space-y-4" onSubmit={onSubmit}>
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
            <p
              className={`rounded-xl border px-3 py-2 text-sm ${
                feedback.type === "error"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
              role="status"
            >
              {feedback.message}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button className="primary-button" type="submit" disabled={isCreating}>
              {isCreating ? "Menyimpan..." : "Buat Workspace"}
            </button>

            {createdInstitutionSlug ? (
              <Link
                className="action-chip"
                href={`/institution/${createdInstitutionSlug}/settings`}
                prefetch={false}
              >
                Buka Pengaturan
              </Link>
            ) : null}
          </div>
        </form>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <SignOutButton />
        <Link className="text-sm underline" href="/" prefetch={false}>
          Kembali ke beranda
        </Link>
      </div>
    </main>
  );
};
