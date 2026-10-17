import type { Metadata } from "next";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ResetLinkErrorState } from "./reset-link-error-state";
import { ResetPasswordForm } from "./reset-password-form";

// The reset token is in this page's URL, so the browser must not hand it on in a Referer header.
export const metadata: Metadata = { referrer: "no-referrer" };

// Does not look the token up on load: a page view must not spend or reveal a link. The server
// judges it when the new password is submitted.
export default async function ResetPasswordPage(props: {
  searchParams?: Promise<{ token?: string }>;
}) {
  const searchParams = await props.searchParams;
  const token = typeof searchParams?.token === "string" ? searchParams.token : "";

  return (
    <AuthPageFrame
      title="Buat password baru."
      description="Pilih password baru untuk akun Anda. Setelah disimpan, Anda perlu masuk lagi di semua perangkat."
    >
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <ResetLinkErrorState
          title="Tautan atur ulang tidak valid"
          description="Tautan tidak lengkap. Minta tautan baru."
        />
      )}
    </AuthPageFrame>
  );
}
