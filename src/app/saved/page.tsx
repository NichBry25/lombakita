import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { listSavedCompetitions } from "@/server/saved-competitions/saved-competition-service";

const formatDate = (d: Date | null) =>
  d
    ? new Date(d).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

export default async function SavedCompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getCurrentSession();

  if (!session || session.user.role !== "student") {
    redirect("/auth/sign-in");
  }

  const { page: pageParam } = await searchParams;
  const page = pageParam ? Number.parseInt(pageParam, 10) : 1;

  const result = await listSavedCompetitions(session.user.id, { page });

  return (
    <main style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 20 }}>Kompetisi Tersimpan</h1>

      {result.data.length === 0 ? (
        <p style={{ fontSize: 14, color: "#555" }}>
          Belum ada kompetisi tersimpan.{" "}
          <Link href="/competitions" style={{ color: "#355795" }}>
            Jelajahi kompetisi
          </Link>
          .
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {result.data.map((item) => (
            <li
              key={item.competitionId}
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: 8,
                padding: 16,
                marginBottom: 12,
                opacity: item.savedStatus === "unavailable" ? 0.6 : 1,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <Link
                    href={`/competitions/${item.institutionSlug}/${item.slug}`}
                    style={{ fontSize: 15, fontWeight: 600, color: "#0F1012", textDecoration: "none" }}
                  >
                    {item.title}
                  </Link>
                  <p style={{ fontSize: 13, color: "#555", marginTop: 4 }}>{item.institutionName}</p>
                  {item.registrationEndAt && (
                    <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                      Batas pendaftaran: {formatDate(item.registrationEndAt)}
                    </p>
                  )}
                  {item.savedStatus === "unavailable" && (
                    <p style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>
                      Kompetisi ini tidak lagi tersedia untuk pendaftaran.
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {result.meta.totalPages > 1 && (
        <div style={{ marginTop: 20, display: "flex", gap: 8, fontSize: 14 }}>
          {page > 1 && (
            <Link
              href={`/saved?page=${page - 1}`}
              style={{ color: "#355795" }}
            >
              ← Sebelumnya
            </Link>
          )}
          <span style={{ color: "#555" }}>
            Halaman {result.meta.page} dari {result.meta.totalPages}
          </span>
          {page < result.meta.totalPages && (
            <Link
              href={`/saved?page=${page + 1}`}
              style={{ color: "#355795" }}
            >
              Berikutnya →
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
