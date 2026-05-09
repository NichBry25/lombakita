import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPublicCompetitionDetail,
  type PublicCompetitionDetail,
} from "@/server/competitions/competition-public-service";

const CATEGORY_LABELS: Record<string, string> = {
  technology: "Teknologi",
  science: "Sains",
  business: "Bisnis",
  creative_arts: "Seni & Kreasi",
  social_humanities: "Sosial & Humaniora",
  sports: "Olahraga",
  academic: "Akademik",
  other: "Lainnya",
};

const MODE_LABELS: Record<string, string> = {
  individual: "Individu",
  team: "Tim",
  both: "Individu / Tim",
};

const formatDate = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

function FeeDisplay({ feeAmount }: { feeAmount: string | null }) {
  const amount = feeAmount ? parseFloat(feeAmount) : 0;
  if (!feeAmount || amount === 0) {
    return <p style={{ fontSize: 14, color: "#2d7a2d", fontWeight: 600 }}>Gratis</p>;
  }
  // "Rp" is hardcoded as IDR — Indonesia-first MVP assumption.
  // feeCurrency is excluded from the public API per DEC-0022; currency formatting is a deferred UX concern.
  return (
    <>
      <p style={{ fontSize: 14 }}>Rp {amount.toLocaleString("id-ID")}</p>
      <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>Pembayaran online segera hadir.</p>
    </>
  );
}

function CTAButton({ ctaState }: { ctaState: PublicCompetitionDetail["ctaState"] }) {
  if (ctaState === "open") {
    return (
      <button
        style={{
          padding: "10px 24px",
          background: "#355795",
          color: "#fff",
          borderRadius: 6,
          border: "none",
          fontSize: 15,
          cursor: "pointer",
        }}
      >
        Register Now
      </button>
    );
  }
  if (ctaState === "not_yet_open") {
    return (
      <button
        disabled
        style={{
          padding: "10px 24px",
          background: "#ccc",
          color: "#555",
          borderRadius: 6,
          border: "none",
          fontSize: 15,
          cursor: "not-allowed",
        }}
      >
        Pendaftaran Belum Dibuka
      </button>
    );
  }
  return (
    <button
      disabled
      style={{
        padding: "10px 24px",
        background: "#ccc",
        color: "#555",
        borderRadius: 6,
        border: "none",
        fontSize: 15,
        cursor: "not-allowed",
      }}
    >
      Pendaftaran Ditutup
    </button>
  );
}

export default async function CompetitionDetailPage({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {
  const { institutionSlug, slug } = await params;
  const competition = await getPublicCompetitionDetail(institutionSlug, slug);

  if (!competition) notFound();

  const showTeamSize =
    competition.mode !== "individual" &&
    (competition.minTeamSize !== null || competition.maxTeamSize !== null);

  return (
    <main style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <Link href="/competitions" style={{ fontSize: 14, color: "#555" }}>
        ← Semua Kompetisi
      </Link>

      <h1 style={{ marginTop: 16, fontSize: 24 }}>{competition.title}</h1>

      {/* Organizer */}
      <div style={{ marginTop: 8, fontSize: 14, color: "#555", display: "flex", alignItems: "center", gap: 6 }}>
        {competition.organizer.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={competition.organizer.logoUrl} alt="" style={{ height: 20 }} />
        )}
        <span>{competition.organizer.name}</span>
      </div>

      {/* Badges */}
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {competition.category && (
          <span
            style={{ padding: "2px 8px", background: "#ECE5FF", borderRadius: 4, fontSize: 13 }}
          >
            {CATEGORY_LABELS[competition.category] ?? competition.category}
          </span>
        )}
        {competition.mode && (
          <span
            style={{ padding: "2px 8px", background: "#e8f0fe", borderRadius: 4, fontSize: 13 }}
          >
            {MODE_LABELS[competition.mode] ?? competition.mode}
          </span>
        )}
      </div>

      {/* Description */}
      {competition.description && (
        <p style={{ marginTop: 20, fontSize: 15, lineHeight: 1.7, whiteSpace: "pre-line" }}>
          {competition.description}
        </p>
      )}

      {/* Timeline */}
      <section style={{ marginTop: 28, borderTop: "1px solid #eee", paddingTop: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Jadwal</h2>
        <table style={{ fontSize: 14, borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ paddingRight: 24, color: "#555", paddingBottom: 8 }}>
                Pendaftaran dibuka
              </td>
              <td style={{ paddingBottom: 8 }}>{formatDate(competition.registrationStartAt)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: "#555", paddingBottom: 8 }}>
                Batas pendaftaran
              </td>
              <td style={{ paddingBottom: 8 }}>{formatDate(competition.registrationEndAt)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: "#555", paddingBottom: 8 }}>
                Mulai kompetisi
              </td>
              <td style={{ paddingBottom: 8 }}>{formatDate(competition.eventStartAt)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: "#555" }}>Akhir kompetisi</td>
              <td>{formatDate(competition.eventEndAt)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Team size */}
      {showTeamSize && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Ukuran Tim</h2>
          <p style={{ fontSize: 14 }}>
            {competition.minTeamSize !== null && competition.maxTeamSize !== null
              ? `${competition.minTeamSize}–${competition.maxTeamSize} orang`
              : competition.minTeamSize !== null
                ? `Min. ${competition.minTeamSize} orang`
                : `Maks. ${competition.maxTeamSize} orang`}
          </p>
        </section>
      )}

      {/* Fee */}
      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Biaya Pendaftaran</h2>
        <FeeDisplay feeAmount={competition.feeAmount} />
      </section>

      {/* Eligibility placeholder */}
      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Persyaratan</h2>
        <p style={{ fontSize: 14, color: "#555" }}>Mahasiswa aktif usia 18–32 tahun.</p>
      </section>

      {/* CTA */}
      <div style={{ marginTop: 32 }}>
        <CTAButton ctaState={competition.ctaState} />
        <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
          Fitur pendaftaran akan tersedia segera.
        </p>
      </div>
    </main>
  );
}
