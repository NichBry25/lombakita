"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ButtonLink, EmptyState, Icon, PageHeader, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { capitalizeWord } from "@/lib/text/capitalize";

type Competition = {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published" | "archived";
  createdAt: string;
};

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
  const { addToast } = useToast();

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions`,
      { cache: "no-store", credentials: "include" },
    );
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competitions: Competition[] };
    setItems(data.competitions);
    setIsLoading(false);
  }, [institutionSlug, addToast]);

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
        backLabel="Kembali"
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
                  {capitalizeWord(c.status)}
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
    </main>
  );
};
