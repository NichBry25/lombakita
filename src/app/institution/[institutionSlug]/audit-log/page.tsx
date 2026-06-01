import { redirect } from "next/navigation";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { desc, eq, sql } from "drizzle-orm";
import { institutionAuditLogs, users } from "@/server/db/schema";

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
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`);
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
    <main style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1>Log Audit — {institutionSlug}</h1>
      <p>
        <a href={`/institution/${institutionSlug}/competitions`}>← Kembali</a>
      </p>

      {events.length === 0 ? (
        <p style={{ marginTop: 24 }}>Tidak ada entri log.</p>
      ) : (
        <table style={{ marginTop: 24, width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Tipe Event
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Aktor
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Ringkasan
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Waktu
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const summary = JSON.stringify(e.metadata ?? {}).slice(0, 80);
              return (
                <tr key={e.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 8, fontFamily: "monospace", fontSize: "0.9em" }}>
                    {e.eventType}
                  </td>
                  <td style={{ padding: 8 }}>{e.actorName ?? "—"}</td>
                  <td
                    style={{
                      padding: 8,
                      fontFamily: "monospace",
                      fontSize: "0.85em",
                      color: "#555",
                    }}
                  >
                    {summary}
                  </td>
                  <td style={{ padding: 8, fontSize: "0.9em" }}>
                    {new Date(e.createdAt).toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div style={{ marginTop: 16, display: "flex", gap: 16 }}>
          {prevHref ? (
            <a href={prevHref}>← Sebelumnya</a>
          ) : (
            <span style={{ color: "#999" }}>← Sebelumnya</span>
          )}
          <span>
            Halaman {page} dari {totalPages}
          </span>
          {nextHref ? (
            <a href={nextHref}>Selanjutnya →</a>
          ) : (
            <span style={{ color: "#999" }}>Selanjutnya →</span>
          )}
        </div>
      )}
    </main>
  );
}
