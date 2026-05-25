import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import {
  decidePostLoginDestination,
  type VerificationState,
} from "@/server/auth/role-verification";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

// Step 4.0b — post-login decision page. The sign-in form sets callbackUrl to this route after
// a successful credentials sign-in. We read the live verification state (not the JWT — the
// freshly-minted JWT is fine but we prefer DB-authoritative read here to keep symmetry with
// dashboard-banner visibility logic) and route accordingly. This is the single place where the
// post-login destination is computed.
export default async function PostLoginPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/sign-in");
  }

  const [row] = await getDb()
    .select({
      candidateVerifiedAt: users.candidateVerifiedAt,
      recruiterVerifiedAt: users.recruiterVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!row) {
    redirect("/auth/sign-in");
  }

  const state: VerificationState = {
    candidateVerified: row.candidateVerifiedAt !== null,
    recruiterVerified: row.recruiterVerifiedAt !== null,
  };

  const destination = decidePostLoginDestination(
    state,
    session.secondRolePromptDismissed === true,
  );

  redirect(destination);
}
