import { redirect } from "next/navigation";
import { ParticipantsFilterForm } from "./filter-form";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  listCompetitionParticipants,
  type ParticipantRecord,
} from "@/server/participants/participant-service";

type Props = {
  params: Promise<{ institutionSlug: string; competitionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ParticipantsPage({ params, searchParams }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug, competitionId } = await params;
  const sp = await searchParams;

  const path = `/institution/${institutionSlug}/competitions/${competitionId}/participants`;

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

  const resolveParam = (val: string | string[] | undefined, fallback: string): string => {
    if (!val) return fallback;
    return Array.isArray(val) ? (val[0] ?? fallback) : val;
  };

  const status = resolveParam(sp.status, "all");
  const type = resolveParam(sp.type, "all");
  const page = parseInt(resolveParam(sp.page, "1"), 10);
  const limit = 20;

  const result = await listCompetitionParticipants(
    institutionId,
    competitionId,
    {
      status: status as "all" | "confirmed" | "cancelled",
      type: type as "all" | "individual" | "team",
      page,
      limit,
    },
    db,
  );

  const buildSearchParams = (overrides: Record<string, string>): string => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (type !== "all") p.set("type", type);
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  };

  const prevHref =
    page > 1 ? `${path}${buildSearchParams({ page: String(page - 1) })}` : null;
  const nextHref =
    page < result.pagination.totalPages
      ? `${path}${buildSearchParams({ page: String(page + 1) })}`
      : null;

  return (
    <main style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1>Peserta — {competitionId}</h1>
      <p>
        <a href={`/institution/${institutionSlug}/competitions`}>← Kembali ke kompetisi</a>
      </p>

      <section style={{ marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>
          Total: <strong>{result.counts.total}</strong>
        </span>
        <span>
          Dikonfirmasi: <strong>{result.counts.confirmed}</strong>
        </span>
        <span>
          Pending: <strong>{result.counts.pending}</strong>
        </span>
        <span>
          Dibatalkan: <strong>{result.counts.cancelled}</strong>
        </span>
        <span>
          Ada submission: <strong>{result.counts.withSubmissions}</strong>
        </span>
        <span>
          Finalisasi: <strong>{result.counts.withFinalizedSubmissions}</strong>
        </span>
      </section>

      <ParticipantsFilterForm path={path} status={status} type={type} />

      {result.participants.length === 0 ? (
        <p style={{ marginTop: 24 }}>Tidak ada peserta.</p>
      ) : (
        <table style={{ marginTop: 24, width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Tipe
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Peserta
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Status
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Anggota
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Submission
              </th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ccc" }}>
                Terdaftar
              </th>
            </tr>
          </thead>
          <tbody>
            {result.participants.map((p: ParticipantRecord) => (
              <tr key={p.registrationId} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 8 }}>
                  {p.registrationType === "team" ? "Tim" : "Individu"}
                </td>
                <td style={{ padding: 8 }}>
                  {p.registrationType === "individual" && p.candidate
                    ? (p.candidate.displayName ?? p.candidate.username)
                    : p.team
                      ? `${p.team.teamName} (Kapten: ${p.team.captainDisplayName ?? "—"})`
                      : "—"}
                </td>
                <td style={{ padding: 8 }}>{p.status}</td>
                <td style={{ padding: 8 }}>
                  {p.registrationType === "team" && p.team ? p.team.activeMemberCount : "—"}
                </td>
                <td style={{ padding: 8 }}>
                  {p.submission === null
                    ? "Tidak ada"
                    : p.submission.finalized
                      ? "Finalisasi"
                      : "Diunggah"}
                </td>
                <td style={{ padding: 8 }}>
                  {new Date(p.registeredAt).toLocaleDateString("id-ID")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result.pagination.totalPages > 1 && (
        <div style={{ marginTop: 16, display: "flex", gap: 16 }}>
          {prevHref ? (
            <a href={prevHref}>← Sebelumnya</a>
          ) : (
            <span style={{ color: "#999" }}>← Sebelumnya</span>
          )}
          <span>
            Halaman {result.pagination.page} dari {result.pagination.totalPages}
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
