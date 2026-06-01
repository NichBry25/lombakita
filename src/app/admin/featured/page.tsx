import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { competitions, institutions } from "@/server/db/schema";
import { FeaturedRowForm } from "./featured-row-form";

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
    .orderBy(desc(competitions.isFeatured), competitions.featuredOrder, desc(competitions.createdAt));

  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        maxWidth: 960,
        margin: "32px auto",
        padding: "0 16px",
        color: "#0f1012",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Pengelolaan Kompetisi Unggulan</h1>
      <p style={{ color: "#555", marginBottom: 20, fontSize: 14 }}>
        Platform Ops — Total kompetisi diterbitkan: {rows.length}
      </p>

      {rows.length === 0 && (
        <p style={{ color: "#888", fontSize: 13 }}>Tidak ada kompetisi yang diterbitkan.</p>
      )}

      {rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f2f7fb", textAlign: "left" }}>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Judul</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Institusi</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Unggulan</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Urutan</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "8px 10px" }}>{row.title}</td>
                <td style={{ padding: "8px 10px", color: "#555" }}>{row.institutionSlug}</td>
                <td style={{ padding: "8px 10px" }}>
                  {row.isFeatured ? (
                    <span style={{ color: "#155724", fontWeight: 600 }}>Ya</span>
                  ) : (
                    <span style={{ color: "#888" }}>Tidak</span>
                  )}
                </td>
                <td style={{ padding: "8px 10px", color: "#555" }}>
                  {row.featuredOrder ?? <em style={{ color: "#aaa" }}>–</em>}
                </td>
                <td style={{ padding: "8px 10px" }}>
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
      )}
    </div>
  );
}
