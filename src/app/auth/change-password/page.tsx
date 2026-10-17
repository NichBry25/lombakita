import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ButtonLink, Icon } from "@/components/ui";
import { isOperationalRole } from "@/lib/access/roles";
import { requireActiveSessionPage } from "@/server/auth/page-guard";
import { accountHasPassword } from "@/server/auth/password-reset";
import { ChangePasswordForm } from "./change-password-form";

const CHANGE_PASSWORD_PATH = "/auth/change-password";

// Does not go through requireRolePage: any signed-in account may change its own password, and the
// MFA gate for operational roles is applied here by hand so the challenge can send them back.
export default async function ChangePasswordPage() {
  const session = await requireActiveSessionPage({ callbackPath: CHANGE_PASSWORD_PATH });

  if (isOperationalRole(session.user.role) && session.user.mfaStatus !== "satisfied") {
    redirect(`/auth/mfa/challenge?callbackUrl=${encodeURIComponent(CHANGE_PASSWORD_PATH)}`);
  }

  const hasPassword = await accountHasPassword(session.user.id);

  return (
    <AuthPageFrame
      title="Ubah password Anda."
      description="Setelah password diubah, Anda keluar dari semua perangkat dan perlu masuk lagi."
    >
      {hasPassword ? (
        <ChangePasswordForm expectedUserId={session.user.id} />
      ) : (
        <div className="auth-state stack-md">
          <span className="auth-state-icon" aria-hidden="true">
            <Icon name="info" size="lg" />
          </span>
          <div className="stack-xs">
            <h1>Akun Anda masuk dengan Google</h1>
            <p>
              Akun ini tidak memiliki password, jadi tidak ada yang bisa diubah. Masuk lewat tombol
              &apos;Lanjut dengan Google&apos;.
            </p>
          </div>
          <ButtonLink href="/" variant="primary">
            Kembali
          </ButtonLink>
        </div>
      )}
    </AuthPageFrame>
  );
}
