import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { isSelfServiceRole } from "@/lib/access/roles";
import { getCurrentSession } from "@/server/auth/session";
import { startMfaEnrolment } from "@/server/auth/mfa/factor-service";
import { renderOtpauthQrDataUrl } from "@/server/auth/mfa/otpauth-qr";
import { MfaEnrollForm } from "./mfa-enroll-form";

const defaultDestination = (role: string): string => (role === "platform_ops" ? "/admin" : "/");

// This page deliberately does NOT go through requireRolePage (page-guard.ts). That guard is what
// SENDS an operational account here when mfaStatus is "enrolment_required", so routing it through
// the same guard again would be a redirect loop. Its own bespoke checks below are the narrower
// question: is this an authenticated operational account that genuinely still needs to enrol?
export default async function MfaEnrollPage(props: {
  searchParams?: Promise<{ callbackUrl?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/auth/mfa/enroll");
  }

  if (isSelfServiceRole(session.user.role)) {
    redirect("/");
  }

  const searchParams = await props.searchParams;
  const callbackUrl = searchParams?.callbackUrl || defaultDestination(session.user.role);

  if (session.user.mfaStatus === "satisfied") {
    redirect(callbackUrl);
  }
  if (session.user.mfaStatus === "challenge_required") {
    redirect(`/auth/mfa/challenge?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  // A fresh secret is minted (or an abandoned one is overwritten) every time this page renders.
  // startMfaEnrolment is idempotent with respect to state (still unverified either way) and cheap;
  // the trade-off is that reloading this page mid-scan means re-scanning the QR, which is far safer
  // than trying to keep an in-progress secret alive across a stateless server render.
  const enrolment = await startMfaEnrolment(session.user.id);
  const qrDataUrl = await renderOtpauthQrDataUrl(enrolment.otpauthUri);

  return (
    <AuthPageFrame
      title="Amankan akun operasional Anda."
      description="Akun platform_ops dan finance_ops wajib mengaktifkan verifikasi dua langkah sebelum dapat melanjutkan."
    >
      {/* Heading and instructions live in the form, not here: enrolment is two screens (scan, then
          save the recovery codes) and only the form knows which one is showing. */}
      <MfaEnrollForm
        secretBase32={enrolment.secretBase32}
        otpauthUri={enrolment.otpauthUri}
        qrDataUrl={qrDataUrl}
        callbackUrl={callbackUrl}
      />
    </AuthPageFrame>
  );
}
