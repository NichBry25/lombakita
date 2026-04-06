import Link from "next/link";
import { SignInForm } from "@/components/auth/sign-in-form";
import { isEmailAuthConfigured } from "@/server/auth/auth.config";

export default async function SignInPage(props: { searchParams?: Promise<{ error?: string }> }) {
  const searchParams = await props.searchParams;
  const error = searchParams?.error;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Sign In</h1>
        <p className="text-sm text-zinc-600">
          Step 1.3 baseline uses Auth.js with Resend magic-link sign-in.
        </p>
      </header>

      <section className="rounded border border-zinc-200 bg-white p-5">
        <SignInForm enabled={isEmailAuthConfigured} />

        {!isEmailAuthConfigured ? (
          <p className="mt-3 text-xs text-amber-700">
            Auth email provider is not fully configured. Set `RESEND_API_KEY` and `AUTH_EMAIL_FROM`
            in your environment.
          </p>
        ) : null}

        {error ? <p className="mt-3 text-xs text-rose-700">Sign-in error: {error}</p> : null}
      </section>

      <p className="text-sm text-zinc-600">
        <Link className="underline" href="/">
          Back to home
        </Link>
      </p>
    </main>
  );
}
