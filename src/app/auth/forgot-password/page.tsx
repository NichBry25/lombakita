import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage(props: {
  searchParams?: Promise<{ email?: string }>;
}) {
  const searchParams = await props.searchParams;
  const initialEmail = typeof searchParams?.email === "string" ? searchParams.email : "";

  return (
    <AuthPageFrame
      title="Atur ulang password Anda."
      description="Masukkan email akun Anda. Kami akan mengirim tautan untuk membuat password baru."
    >
      <ForgotPasswordForm initialEmail={initialEmail} />
    </AuthPageFrame>
  );
}
