import Link from "next/link";

export default function VerifyRequestPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">Check your email</h1>
      <p className="text-sm text-zinc-700">
        If your email is eligible for this environment, a magic link has been sent.
      </p>
      <p className="text-sm text-zinc-600">
        <Link className="underline" href="/auth/sign-in">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
