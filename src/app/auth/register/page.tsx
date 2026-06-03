import { SignInForm } from "@/components/auth/sign-in-form";
import { SignupForm } from "@/components/auth/signup-form";
import { isEmailAuthConfigured } from "@/server/auth/auth.config";
import { isSignupRole } from "@/server/auth/credentials-auth";

// Register entry. Bare /auth/register shows the auth shell in register mode (role-picker);
// /auth/register?as=candidate and /auth/register?as=recruiter show the role-specific signup form.
// The login view lives at /auth/login; the in-form toggle navigates between the two routes.
// Old route /auth/signup redirects here (see auth/signup/page.tsx).
export default async function RegisterPage(props: {
  searchParams?: Promise<{
    as?: string;
    callbackUrl?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;

  if (asParam && isSignupRole(asParam)) {
    return <SignupForm signupRole={asParam} verificationEnabled={isEmailAuthConfigured} />;
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-12">
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 md:p-6">
        <SignInForm
          verificationEnabled={isEmailAuthConfigured}
          callbackUrl={searchParams?.callbackUrl}
          initialMode="register"
        />
      </section>
    </main>
  );
}
