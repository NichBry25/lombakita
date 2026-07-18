import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { competitions, institutions } from "@/server/db/schema";
import { FeaturedRowForm } from "./featured-row-form";
import { EmptyState, PageHeader } from "@/components/ui";

// Protected by /admin/layout.tsx — platform_ops only.
export default async function AdminFeaturedPage() {
  const db = getDb();

  const rows = await db
    .select({
      id: competitions.id,
      title: competitions.title,
      isFeatured: competitions.isFeatured,
      featuredOrder: competitions.featuredOrder,
      institutionSlug: institutions.slug,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(and(eq(competitions.status, "published"), isNull(competitions.deletedAt)))
    .orderBy(
      desc(competitions.isFeatured),
      competitions.featuredOrder,
      desc(competitions.createdAt),
    );

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        eyebrow="Kurasi penemuan"
        title="Kompetisi unggulan"
        description="Atur kompetisi terbit yang mendapatkan prioritas di permukaan penemuan publik."
        backHref="/admin"
        backLabel="Panel Platform Ops"
        actions={<span className="status-badge data-text">{rows.length} terbit</span>}
      />

      {rows.length === 0 && (
        <EmptyState
          icon="trophy"
          title="Tidak ada kompetisi diterbitkan."
          description="Kompetisi akan tersedia untuk dikurasi setelah statusnya published."
        />
      )}

      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table admin-featured-table">
            <thead>
              <tr>
                <th>Judul</th>
                <th>Institusi</th>
                <th>Unggulan</th>
                <th>Urutan</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td className="data-text">{row.institutionSlug}</td>
                  <td>
                    {row.isFeatured ? (
                      <span className="status-badge" data-status="featured">
                        Ya
                      </span>
                    ) : (
                      <span className="status-badge">Tidak</span>
                    )}
                  </td>
                  <td className="data-text">{row.featuredOrder ?? <em>–</em>}</td>
                  <td>
                    <FeaturedRowForm
                      competitionId={row.id}
                      initialIsFeatured={row.isFeatured}
                      initialFeaturedOrder={row.featuredOrder}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
