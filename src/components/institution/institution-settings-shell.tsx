"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";

type InstitutionSettingsResponse = {
  institution: {
    institutionId: string;
    displayName: string;
    slug: string;
    status: "active" | "inactive" | "suspended";
    ownerMembership: {
      membershipId: string;
      membershipRole: "institution_admin" | "institution_staff" | "reviewer_or_judge";
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

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (displayName.trim().length < 2) {
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
        body: JSON.stringify({
          displayName,
          slug,
        }),
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
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-14">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-gleam">Pengaturan Institusi</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Minimal settings shell Step 2.2 untuk pemilik institusi.
        </p>
      </header>

      <section className="glass-card p-6">
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Memuat data institusi...</p>
        ) : (
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="form-field">
              <label className="form-label" htmlFor="institution-settings-display-name">
                Nama Institusi
              </label>
              <input
                id="institution-settings-display-name"
                className="form-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-settings-slug">
                Slug
              </label>
              <input
                id="institution-settings-slug"
                className="form-input"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="institution-settings-status">
                Status Awal Platform
              </label>
              <input
                id="institution-settings-status"
                className="form-input form-input-readonly"
                value={status}
                readOnly
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

            <button className="primary-button" type="submit" disabled={isSaving}>
              {isSaving ? "Menyimpan..." : "Simpan Perubahan"}
            </button>
          </form>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <SignOutButton />
        <Link className="text-sm underline" href="/institution/workspace" prefetch={false}>
          Buat workspace lain
        </Link>
        <Link className="text-sm underline" href="/" prefetch={false}>
          Kembali ke beranda
        </Link>
      </div>
    </main>
  );
};
