import Link from "next/link";
import { getCurrentSession } from "@/server/auth/session";
import { getTeamInvitationMetaByToken } from "@/server/teams/team-service";
import { TeamError } from "@/server/teams/team-core";
import { InvitationActions } from "./invitation-actions";

export default async function TeamInvitationLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let meta;
  try {
    meta = await getTeamInvitationMetaByToken(token);
  } catch (error) {
    if (error instanceof TeamError) {
      return (
        <main style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}>
          <h1 style={{ fontSize: 22 }}>Undangan tidak ditemukan</h1>
          <p style={{ marginTop: 8, color: "#a23" }}>
            <strong>{error.code}</strong>: {error.message}
          </p>
          <p style={{ marginTop: 12 }}>
            <Link href="/" style={{ color: "#355795" }}>
              ← Beranda
            </Link>
          </p>
        </main>
      );
    }
    throw error;
  }

  const session = await getCurrentSession();

  return (
    <main style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22 }}>Undangan Tim</h1>
      <p style={{ marginTop: 8, color: "#555" }}>
        <strong>{meta.inviterDisplayName ?? "Kapten tim"}</strong> mengundang Anda untuk
        bergabung dengan tim <strong>{meta.teamName}</strong> pada kompetisi{" "}
        <strong>{meta.competitionTitle}</strong>.
      </p>
      <p style={{ marginTop: 8, fontSize: 13, color: "#555" }}>
        Berlaku hingga {meta.expiresAt.toLocaleDateString("id-ID")}.
      </p>

      {meta.status === "accepted" && (
        <p
          role="status"
          style={{
            marginTop: 16,
            padding: 8,
            background: "#dff5dd",
            color: "#256029",
            borderRadius: 4,
            fontSize: 14,
          }}
        >
          ✓ Undangan ini sudah Anda terima.
        </p>
      )}

      {(meta.status === "declined" || meta.status === "cancelled") && (
        <p style={{ marginTop: 16, color: "#555" }}>
          Undangan ini sudah {meta.status === "declined" ? "ditolak" : "dibatalkan"}.
        </p>
      )}

      {meta.status === "pending" && (
        <InvitationActions
          token={token}
          isAuthenticated={Boolean(session?.user)}
          sessionEmail={session?.user?.email ?? null}
          invitedEmail={meta.invitedEmail}
          sessionRole={session?.user?.role ?? null}
          expiresAtIso={meta.expiresAt.toISOString()}
        />
      )}
    </main>
  );
}
