import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Feedback } from "@/components/ui";
import { isSelfServiceRole } from "@/lib/access/roles";
import { sameSitePathOr } from "@/lib/session/return-path";
import { requireActiveSessionPage } from "@/server/auth/page-guard";
import {
  dashboardPathForRole,
  getUnverifiedRoles,
  isVerifiableRole,
  type VerifiableRole,
} from "@/server/auth/role-verification";
import { VerifyRoleForm } from "./verify-role-form";

const ROLE_HEADLINE: Record<VerifiableRole, string> = {
  candidate: "Daftar sebagai peserta",
  recruiter: "Daftar sebagai penyelenggara",
};

// Verification mechanics are deferred. This page collects the per-role verification data
// and flips the per-role *_verified_at timestamp via the completion API. The candidate path
// mirrors the registration onboarding form (full name, phone, occupation, date of birth).
export default async function VerifyRolePage(props: {
  searchParams?: Promise<{ as?: string; callbackUrl?: string }>;
}) {
  const session = await requireActiveSessionPage({ callbackPath: "/" });

  // Only a self-service account may acquire a participant role. Operational accounts still carry
  // the candidate or recruiter verification they were created with, but must not collect another
  // — mirrors the role gate on the completion endpoint.
  if (!isSelfServiceRole(session.user.role)) {
    redirect("/");
  }

  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;
  // A competition page sends a host here with its own address, to return to once the role is added.
  const checkedReturnPath = sameSitePathOr(searchParams?.callbackUrl, "");
  const returnPath = checkedReturnPath === "" ? null : checkedReturnPath;
  const backHref = returnPath ?? "/";

  if (!isVerifiableRole(asParam)) {
    return (
      <AuthPageFrame
        title="Pilih peran Anda"
        description="Satu akun dapat menjadi peserta sekaligus penyelenggara."
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
          <ButtonLink href={backHref} variant="outline">
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
    redirect(returnPath ?? dashboardPathForRole(role));
  }

  return (
    <AuthPageFrame
      title="Lengkapi data untuk membuka akses"
      description="Satu akun dapat menjadi peserta sekaligus penyelenggara."
    >
      <div className="stack-md">
        <header className="auth-entry-header">
          <h1>{ROLE_HEADLINE[role]}</h1>
        </header>

        {role === "recruiter" ? (
          <p>Sebagai penyelenggara, Anda dapat menerbitkan dan mengelola kompetisi.</p>
        ) : null}

        <VerifyRoleForm role={role} expectedUserId={session.user.id} returnPath={returnPath} />
        <ButtonLink href={backHref} variant="link" size="sm">
          Kembali
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
