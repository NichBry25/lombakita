import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPublicCompetitionDetail,
  type PublicCompetitionDetail,
} from "@/server/competitions/competition-public-service";
import { getCurrentSession } from "@/server/auth/session";
import { isSavedCompetition } from "@/server/saved-competitions/saved-competition-service";
import { SaveButton } from "./save-button";
import { formatTeamSizeText } from "./team-size-utils";

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

// F4: Registration window dates include HH:MM so candidates can read exact close time.
const formatDateTime = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";


function FeeDisplay({ feeAmount }: { feeAmount: string | null }) {
  const amount = feeAmount ? parseFloat(feeAmount) : 0;
  if (!feeAmount || amount === 0) {
    return <p style={{ fontSize: 14, color: "#2d7a2d", fontWeight: 600 }}>Gratis</p>;
  }
  // "Rp" is hardcoded as IDR — Indonesia-first MVP assumption.
  return (
    <>
      <p style={{ fontSize: 14 }}>Rp {amount.toLocaleString("id-ID")}</p>
      <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>Pembayaran online segera hadir.</p>
    </>
  );
}

// CTA button on the detail page is a *navigation link*, not a mutation. Clicking takes the
// candidate to the dedicated `/registration` subpage where the actual register/team flows live.
// This keeps the read surface (this page) cleanly separated from the act surface (registration).
function CTANavLink({
  ctaState,
  registrationPath,
  isCandidate,
}: {
  ctaState: PublicCompetitionDetail["ctaState"];
  registrationPath: string;
  isCandidate: boolean;
}) {
  if (ctaState === "open" && isCandidate) {
    return (
      <Link
        href={registrationPath}
        style={{
          display: "inline-block",
          padding: "10px 24px",
          background: "#355795",
          color: "#fff",
          borderRadius: 6,
          fontSize: 15,
          textDecoration: "none",
        }}
      >
        Daftar
      </Link>
    );
  }
  if (ctaState === "open" && !isCandidate) {
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
        Daftar
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
      {ctaState === "not_yet_open" ? "Pendaftaran Belum Dibuka" : "Pendaftaran Ditutup"}
    </button>
  );
}

export default async function CompetitionDetailPage({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {
  const { institutionSlug, slug } = await params;
  const [competition, session] = await Promise.all([
    getPublicCompetitionDetail(institutionSlug, slug),
    getCurrentSession(),
  ]);

  if (!competition) notFound();

  const isCandidate = session?.user?.role === "candidate";
  const initialSaved = isCandidate
    ? await isSavedCompetition(session!.user.id, competition.id)
    : false;

  const registrationPath = `/competitions/${institutionSlug}/${slug}/registration`;

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
      <div
        style={{
          marginTop: 8,
          fontSize: 14,
          color: "#555",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
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
              <td style={{ paddingBottom: 8 }}>{formatDateTime(competition.registrationStartAt)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: "#555", paddingBottom: 8 }}>
                Batas pendaftaran
              </td>
              <td style={{ paddingBottom: 8 }}>{formatDateTime(competition.registrationEndAt)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: "#555", paddingBottom: 8 }}>Mulai kompetisi</td>
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
            {formatTeamSizeText(competition.minTeamSize, competition.maxTeamSize)}
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

      {/* CTA — navigation only. The actual register/team flow lives at /registration. */}
      <div style={{ marginTop: 32 }}>
        <CTANavLink
          ctaState={competition.ctaState}
          registrationPath={registrationPath}
          isCandidate={isCandidate}
        />
        {!session?.user && (
          <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
            <Link href="/auth/sign-in" style={{ color: "#355795" }}>
              Masuk
            </Link>{" "}
            sebagai mahasiswa untuk mendaftar.
          </p>
        )}
        {session?.user && !isCandidate && (
          <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
            Hanya akun kandidat yang dapat mendaftar.
          </p>
        )}
      </div>

      {/* Save */}
      <div style={{ marginTop: 8 }}>
        {isCandidate ? (
          <SaveButton
            competitionId={competition.id}
            initialSaved={initialSaved}
            expectedUserId={session!.user.id}
          />
        ) : (
          <p style={{ fontSize: 13, color: "#888", marginTop: 16 }}>
            <Link href="/auth/sign-in" style={{ color: "#355795" }}>
              Masuk
            </Link>{" "}
            untuk menyimpan kompetisi ini.
          </p>
        )}
      </div>
    </main>
  );
}
