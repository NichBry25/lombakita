import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { isSelfServiceRole } from "@/lib/access/roles";
import { getCurrentSession } from "@/server/auth/session";
import { MfaChallengeForm } from "./mfa-challenge-form";

const defaultDestination = (role: string): string => (role === "platform_ops" ? "/admin" : "/");

// Does NOT go through requireRolePage for the same reason /auth/mfa/enroll does not — this page is
// exactly what an account in "challenge_required" must be able to reach.
export default async function MfaChallengePage(props: {
  searchParams?: Promise<{ callbackUrl?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/auth/mfa/challenge");
  }

  if (isSelfServiceRole(session.user.role)) {
    redirect("/");
  }

  const searchParams = await props.searchParams;
  const callbackUrl = searchParams?.callbackUrl || defaultDestination(session.user.role);

  if (session.user.mfaStatus === "satisfied") {
    redirect(callbackUrl);
  }
  if (session.user.mfaStatus === "enrolment_required") {
    redirect(`/auth/mfa/enroll?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  return (
    <AuthPageFrame
      title="Verifikasi dua langkah diperlukan."
      description="Masukkan kode dari aplikasi autentikator Anda untuk melanjutkan sesi ini."
    >
      {/* The heading lives in the form, not here: it names the step the operator is on, and the
          form is what knows which step that is. */}
      <MfaChallengeForm callbackUrl={callbackUrl} />
    </AuthPageFrame>
  );
}
