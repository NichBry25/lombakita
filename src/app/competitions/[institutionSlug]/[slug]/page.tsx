import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPublicCompetitionDetail,
  type PublicCompetitionDetail,
} from "@/server/competitions/competition-public-service";
import { getCurrentSession } from "@/server/auth/session";
import { isSavedCompetition } from "@/server/saved-competitions/saved-competition-service";
import { getStudentRegistration } from "@/server/registrations/registration-service";
import { SaveButton } from "./save-button";
import { RegisterButton } from "./register-button";

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

// Static CTA placeholder for non-student visitors. Students see <RegisterButton /> instead,
// which handles register/cancel and reflects the live registration state from the /me endpoint.
function VisitorCTAButton({ ctaState }: { ctaState: PublicCompetitionDetail["ctaState"] }) {
  if (ctaState === "open") {
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

  const isStudent = session?.user?.role === "candidate";
  const [initialSaved, initialRegistration] = isStudent
    ? await Promise.all([
        isSavedCompetition(session!.user.id, competition.id),
        getStudentRegistration(session!.user.id, competition.id),
      ])
    : [false, null];

  // Individual registration is only valid for `individual` and `both` modes. `team` is
  // routed through Steps 4.3/4.4 (out of scope here).
  const wrongMode = competition.mode === "team";

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
              <td style={{ paddingBottom: 8 }}>{formatDate(competition.registrationStartAt)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: "#555", paddingBottom: 8 }}>
                Batas pendaftaran
              </td>
              <td style={{ paddingBottom: 8 }}>{formatDate(competition.registrationEndAt)}</td>
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
        {isStudent ? (
          <RegisterButton
            competitionId={competition.id}
            ctaState={competition.ctaState}
            initialRegistration={
              initialRegistration
                ? { id: initialRegistration.id, status: initialRegistration.status }
                : null
            }
            wrongMode={wrongMode}
          />
        ) : (
          <>
            <VisitorCTAButton ctaState={competition.ctaState} />
            <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
              <Link href="/auth/sign-in" style={{ color: "#355795" }}>
                Masuk
              </Link>{" "}
              sebagai mahasiswa untuk mendaftar.
            </p>
          </>
        )}
      </div>

      {/* Save */}
      <div style={{ marginTop: 8 }}>
        {isStudent ? (
          <SaveButton competitionId={competition.id} initialSaved={initialSaved} />
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
