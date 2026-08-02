import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Feedback } from "@/components/ui";
import { isSelfServiceRole } from "@/lib/access/roles";
import { getCurrentSession } from "@/server/auth/session";
import {
  dashboardPathForRole,
  getUnverifiedRoles,
  isVerifiableRole,
  type VerifiableRole,
} from "@/server/auth/role-verification";
import { VerifyRoleForm } from "./verify-role-form";

const ROLE_HEADLINE: Record<VerifiableRole, string> = {
  candidate: "Verifikasi sebagai Kandidat",
  recruiter: "Verifikasi sebagai Rekruter",
};

// Verification mechanics are deferred. This page collects the per-role verification data
// and flips the per-role *_verified_at timestamp via the completion API. The candidate path
// mirrors the registration onboarding form (full name, phone, occupation, date of birth).
export default async function VerifyRolePage(props: { searchParams?: Promise<{ as?: string }> }) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/");
  }

  // Only a self-service account may acquire a participant role. Operational accounts still carry
  // the candidate or recruiter verification they were created with, but must not collect another
  // — mirrors the role gate on the completion endpoint.
  if (!isSelfServiceRole(session.user.role)) {
    redirect("/");
  }

  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;

  if (!isVerifiableRole(asParam)) {
    return (
      <AuthPageFrame
        title="Pilih peran Anda."
        description="Kandidat dan rekruter diverifikasi terpisah."
      >
        <div className="auth-state stack-md">
          <span className="auth-state-icon" data-tone="error" aria-hidden="true">
            !
          </span>
          <div className="stack-xs">
            <h1>Verifikasi peran</h1>
            <Feedback tone="error">
              Parameter <code>?as=</code> tidak valid. Gunakan <code>?as=candidate</code> atau{" "}
              <code>?as=recruiter</code>.
            </Feedback>
          </div>
          <ButtonLink href="/" variant="outline">
            Kembali
          </ButtonLink>
        </div>
      </AuthPageFrame>
    );
  }

  const role = asParam;
  const unverified = await getUnverifiedRoles(session.user.id);

  // If the role is already verified for this account, send the user on. Avoids a confusing
  // "complete verification" button that would 409 immediately on submit.
  if (!unverified.includes(role)) {
    redirect(dashboardPathForRole(role));
  }

  return (
    <AuthPageFrame
      title="Lengkapi data untuk membuka akses."
      description="Kandidat dan rekruter diverifikasi terpisah. Anda bisa menambah peran lain nanti."
    >
      <div className="stack-md">
        <header className="auth-entry-header">
          <p className="eyebrow">Verifikasi peran</p>
          <h1>{ROLE_HEADLINE[role]}</h1>
        </header>

        {role === "recruiter" ? (
          <p>Verifikasi peran rekruter Anda untuk mulai menerbitkan dan mengelola peluang.</p>
        ) : null}

        <VerifyRoleForm role={role} />
        <ButtonLink href="/" variant="ghost" size="sm">
          Kembali
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
