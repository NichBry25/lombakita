import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { InstitutionMembersShell } from "@/components/institution/institution-members-shell";
import { getCurrentSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { institutionMemberships, institutions } from "@/server/db/schema";

const PAGE_PATH = "/dashboard/institution/members";

export default async function InstitutionMembersPage() {
  const session = await getCurrentSession();
  const userId = session?.user?.id;

  if (!userId) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(PAGE_PATH)}`);
  }

  const db = getDb();

  const [adminMembership] = await db
    .select({
      institutionId: institutionMemberships.institutionId,
      institutionSlug: institutions.slug,
    })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .where(
      and(
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, "institution_admin"),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (adminMembership) {
    return (
      <InstitutionMembersShell
        institutionId={adminMembership.institutionId}
        institutionSlug={adminMembership.institutionSlug}
        actorUserId={userId}
      />
    );
  }

  // Authenticated but not an admin — check for any active membership.
  // Staff members land on their institution settings page instead.
  const [anyMembership] = await db
    .select({ institutionSlug: institutions.slug })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .where(
      and(eq(institutionMemberships.userId, userId), eq(institutionMemberships.status, "active")),
    )
    .limit(1);

  if (anyMembership) {
    redirect(`/institution/${anyMembership.institutionSlug}/settings`);
  }

  redirect("/institution/workspace");
}
