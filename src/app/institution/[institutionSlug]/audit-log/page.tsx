import { redirect } from "next/navigation";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { getDb } from "@/server/db/client";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { desc, eq, sql } from "drizzle-orm";
import { institutionAuditLogs, users } from "@/server/db/schema";
import {
  EmptyState,
  PageHeader,
  Pagination,
  Table,
  TableDataList,
  TableExpandToggle,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { auditEventDataEntries, auditEventName, auditEventSummary } from "./audit-event-display";

type Props = {
  params: Promise<{ institutionSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const AUDIT_COLUMNS: readonly TableColumn[] = [
  { key: "event", header: "Peristiwa", kind: "name" },
  { key: "actor", header: "Aktor", kind: "text" },
  { key: "summary", header: "Ringkasan", kind: "long" },
  { key: "time", header: "Waktu", kind: "date" },
  { key: "data", header: "Tindakan", kind: "control", hideHeader: true },
];

export default async function AuditLogPage({ params, searchParams }: Props) {
  const { institutionSlug } = await params;
  const sp = await searchParams;

  const path = `/institution/${institutionSlug}/audit-log`;
  const session = await requireRolePage("recruiter", { callbackPath: path });

  const db = getDb();
  let institutionId: string;
  try {
    ({ institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug.trim().toLowerCase(),
      db,
    ));
  } catch (e) {
    if (e instanceof AccessError && e.code === "account_state_unavailable") throw e;
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

  const auditRows: TableRowData[] = events.map((event) => ({
    key: event.id,
    cells: {
      event: auditEventName(event.eventType),
      actor: event.actorName,
      summary: auditEventSummary(event.eventType, event.metadata),
      time: <LocalDate value={event.createdAt} format="shortDateTimeSeconds" />,
      data: <TableExpandToggle>Lihat data</TableExpandToggle>,
    },
    band: <TableDataList entries={auditEventDataEntries(event.metadata)} />,
  }));

  return (
    <main className="page-shell app-page audit-log-page">
      <PageHeader
        title="Log audit"
        description={`Riwayat perubahan penting untuk ${institutionSlug}, diurutkan dari yang terbaru.`}
        backHref={`/institution/${institutionSlug}`}
      />

      {events.length === 0 ? (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada entri audit"
          description="Tindakan administratif dan perubahan penting akan muncul di sini."
        />
      ) : (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <h2>{total} entri tercatat</h2>
            </div>
          </div>
          <Table label="Log audit" columns={AUDIT_COLUMNS} rows={auditRows} />
        </section>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        label="Halaman log audit"
        hrefFor={(target) => `${path}?page=${target}`}
      />
    </main>
  );
}
