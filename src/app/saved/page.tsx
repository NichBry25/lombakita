import Link from "next/link";
import { requireRolePage } from "@/server/auth/page-guard";
import { listSavedCompetitions } from "@/server/saved-competitions/saved-competition-service";
import { EmptyState, Icon, PageHeader, Pagination } from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";

export default async function SavedCompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await requireRolePage("candidate", { callbackPath: "/saved" });

  const { page: pageParam } = await searchParams;
  const page = pageParam ? Number.parseInt(pageParam, 10) : 1;

  const result = await listSavedCompetitions(session.user.id, { page });

  return (
    <main className="page-shell app-page saved-page">
      <PageHeader title="Kompetisi tersimpan" />

      {result.data.length === 0 ? (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada kompetisi tersimpan"
          description="Gunakan tombol simpan di halaman detail kompetisi untuk mengisi daftar ini."
          action={{ label: "Jelajahi kompetisi", href: "/competitions" }}
        />
      ) : (
        <ul className="saved-grid">
          {result.data.map((item) => (
            <li
              key={item.competitionId}
              className="saved-card"
              data-unavailable={item.savedStatus === "unavailable" ? "true" : undefined}
            >
              <span className="saved-card-icon" aria-hidden="true">
                <Icon name="bookmark" size="md" />
              </span>
              <div className="record-row-main">
                <Link
                  href={`/competitions/${item.institutionSlug}/${item.slug}`}
                  className="record-row-title"
                >
                  {item.title}
                </Link>
                <p className="record-meta">{item.institutionName}</p>
                {item.registrationEndAt ? (
                  <p className="record-meta">
                    Batas pendaftaran:{" "}
                    <LocalDate value={item.registrationEndAt} format="longDate" />
                  </p>
                ) : null}
                {item.savedStatus === "unavailable" ? (
                  <p className="record-note record-note-error">
                    Kompetisi ini tidak lagi tersedia untuk pendaftaran.
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={result.meta.page}
        totalPages={result.meta.totalPages}
        label="Halaman kompetisi tersimpan"
        hrefFor={(target) => `/saved?page=${target}`}
      />
    </main>
  );
}
