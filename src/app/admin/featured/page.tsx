import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { competitions, institutions } from "@/server/db/schema";
import { FeaturedRowForm } from "./featured-row-form";
import {
  EmptyState,
  PageHeader,
  Table,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";

const FEATURED_COLUMNS: readonly TableColumn[] = [
  { key: "title", header: "Judul", kind: "name" },
  { key: "institution", header: "Institusi", kind: "text" },
  { key: "order", header: "Urutan", kind: "number" },
  { key: "actions", header: "Tindakan", kind: "control", hideHeader: true },
];

export default async function AdminFeaturedPage() {
  await requireRolePage("platform_ops", { callbackPath: "/admin/featured" });

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

  const featuredRows: TableRowData[] = rows.map((row) => ({
    key: row.id,
    cells: {
      title: row.title,
      institution: row.institutionSlug,
      order: row.featuredOrder,
      actions: (
        <FeaturedRowForm
          competitionId={row.id}
          initialIsFeatured={row.isFeatured}
          initialFeaturedOrder={row.featuredOrder}
        />
      ),
    },
  }));

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Kompetisi unggulan"
        description="Atur kompetisi yang tampil lebih dulu di halaman kompetisi."
        titleMark={
          rows.length > 0 ? (
            <span className="status-badge data-text">{rows.length} terbit</span>
          ) : null
        }
      />

      {rows.length === 0 && (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada kompetisi yang terbit"
          description="Kompetisi bisa dipilih setelah statusnya Terbit."
        />
      )}

      {rows.length > 0 && (
        <Table label="Kompetisi unggulan" columns={FEATURED_COLUMNS} rows={featuredRows} stacked />
      )}
    </main>
  );
}
