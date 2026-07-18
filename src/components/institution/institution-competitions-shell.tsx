"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ButtonLink, EmptyState, Icon, PageHeader, Skeleton } from "@/components/ui";

type Competition = {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published" | "archived";
  createdAt: string;
};

type FeedbackState = { type: "success" | "error"; message: string } | null;

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan gagal diproses.";
  } catch {
    return "Permintaan gagal diproses.";
  }
};

export const InstitutionCompetitionsShell = ({ institutionSlug }: { institutionSlug: string }) => {
  const [items, setItems] = useState<Competition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions`,
      { cache: "no-store", credentials: "include" },
    );
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competitions: Competition[] };
    setItems(data.competitions);
    setIsLoading(false);
  }, [institutionSlug]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <main className="page-shell app-page competition-management-page">
      <PageHeader
        eyebrow="Portofolio institusi"
        title="Kompetisi"
        description={`Kelola seluruh kompetisi yang diterbitkan melalui ${institutionSlug}.`}
        backHref={`/institution/${institutionSlug}`}
        backLabel="Panel institusi"
        actions={
          <>
            <ButtonLink
              href={`/institution/${institutionSlug}/audit-log`}
              variant="outline"
              size="sm"
            >
              Log audit
            </ButtonLink>
            <ButtonLink
              href={`/institution/${institutionSlug}/competitions/new`}
              variant="primary"
              size="sm"
            >
              Buat kompetisi
            </ButtonLink>
          </>
        }
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Daftar workspace</p>
            <h2>Kompetisi tersimpan</h2>
          </div>
          <span className="status-badge data-text">{items.length}</span>
        </div>
        {isLoading ? (
          <div className="stack-sm" aria-label="Memuat kompetisi">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="trophy"
            title="Belum ada kompetisi."
            description="Mulai dari draf baru, lalu lengkapi seluruh informasi sebelum diterbitkan."
            action={
              <ButtonLink
                href={`/institution/${institutionSlug}/competitions/new`}
                variant="primary"
              >
                Buat draf pertama
              </ButtonLink>
            }
          />
        ) : (
          <ul className="management-competition-list">
            {items.map((c) => (
              <li key={c.id} className="management-competition-card">
                <span className="management-competition-mark" aria-hidden="true">
                  <Icon name="trophy" size="md" />
                </span>
                <div className="record-row-main">
                  <Link
                    href={`/institution/${institutionSlug}/competitions/${c.slug}`}
                    className="record-row-title"
                  >
                    {c.title}
                  </Link>
                  <span className="record-meta data-text">/{c.slug}</span>
                </div>
                <span
                  className="status-badge"
                  data-status={
                    c.status === "published"
                      ? "open"
                      : c.status === "archived"
                        ? "closed"
                        : "closing"
                  }
                >
                  {c.status}
                </span>
                <ButtonLink
                  href={`/institution/${institutionSlug}/competitions/${c.slug}/participants`}
                  variant="outline"
                  size="sm"
                >
                  Peserta
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      {feedback ? (
        <p role="status" className="feedback" data-tone={feedback.type}>
          {feedback.message}
        </p>
      ) : null}
    </main>
  );
};
