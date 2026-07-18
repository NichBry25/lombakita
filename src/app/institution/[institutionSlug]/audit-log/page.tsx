import { redirect } from "next/navigation";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { desc, eq, sql } from "drizzle-orm";
import { institutionAuditLogs, users } from "@/server/db/schema";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";

type Props = {
  params: Promise<{ institutionSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AuditLogPage({ params, searchParams }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const sp = await searchParams;

  const path = `/institution/${institutionSlug}/audit-log`;

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(path)}`);
  }
  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  const db = getDb();
  let institutionId: string;
  try {
    ({ institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug.trim().toLowerCase(),
      db,
    ));
  } catch (e) {
    if (e instanceof AccessError) redirect("/");
    throw e;
  }

  const rawPage = parseInt(Array.isArray(sp.page) ? (sp.page[0] ?? "1") : (sp.page ?? "1"), 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const [events, countRows] = await Promise.all([
    db
      .select({
        id: institutionAuditLogs.id,
        eventType: institutionAuditLogs.action,
        actorName: users.name,
        metadata: institutionAuditLogs.metadata,
        createdAt: institutionAuditLogs.createdAt,
      })
      .from(institutionAuditLogs)
      .leftJoin(users, eq(users.id, institutionAuditLogs.actorUserId))
      .where(eq(institutionAuditLogs.institutionId, institutionId))
      .orderBy(desc(institutionAuditLogs.createdAt))
      .limit(limit)
      .offset(offset),

    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(institutionAuditLogs)
      .where(eq(institutionAuditLogs.institutionId, institutionId)),
  ]);

  const total = countRows[0]?.count ?? 0;
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

  const prevHref = page > 1 ? `${path}?page=${page - 1}` : null;
  const nextHref = page < totalPages ? `${path}?page=${page + 1}` : null;

  return (
    <main className="page-shell app-page audit-log-page">
      <PageHeader
        eyebrow="Tata kelola institusi"
        title="Log audit"
        description={`Riwayat perubahan penting untuk ${institutionSlug}, diurutkan dari yang terbaru.`}
        backHref={`/institution/${institutionSlug}`}
        backLabel="Panel institusi"
      />

      {events.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="Belum ada entri audit."
          description="Tindakan administratif dan perubahan penting akan tercatat di sini."
        />
      ) : (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Aktivitas terbaru</p>
              <h2>{total} entri tercatat</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table className="data-table audit-log-table">
              <thead>
                <tr>
                  <th>Tipe event</th>
                  <th>Aktor</th>
                  <th>Ringkasan</th>
                  <th>Waktu</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const summary = JSON.stringify(e.metadata ?? {}).slice(0, 80);
                  return (
                    <tr key={e.id}>
                      <td className="data-text">{e.eventType}</td>
                      <td>{e.actorName ?? "—"}</td>
                      <td className="data-text audit-summary">{summary}</td>
                      <td className="data-text">{new Date(e.createdAt).toLocaleString("id-ID")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {totalPages > 1 && (
        <nav className="pagination" aria-label="Halaman log audit">
          {prevHref ? (
            <ButtonLink href={prevHref} variant="outline" size="sm">
              ← Sebelumnya
            </ButtonLink>
          ) : (
            <span className="ui-button" data-variant="outline" data-size="sm" aria-disabled="true">
              ← Sebelumnya
            </span>
          )}
          <span className="pagination-status data-text">
            Halaman {page} dari {totalPages}
          </span>
          {nextHref ? (
            <ButtonLink href={nextHref} variant="outline" size="sm">
              Selanjutnya →
            </ButtonLink>
          ) : (
            <span className="ui-button" data-variant="outline" data-size="sm" aria-disabled="true">
              Selanjutnya →
            </span>
          )}
        </nav>
      )}
    </main>
  );
}
