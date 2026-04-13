"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";

export const SignInForm = ({ enabled }: { enabled: boolean }) => {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!enabled || !email.trim()) {
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      await signIn("email", {
        email: email.trim().toLowerCase(),
        callbackUrl: "/protected",
      });
      setStatusMessage("If this email is recognized, a magic link has been sent.");
    } catch {
      setErrorMessage("Could not send magic link. Check email provider credentials and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block text-sm font-medium" htmlFor="email">
        Email address
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        placeholder="you@university.ac.id"
      />
      <button
        type="submit"
        disabled={!enabled || isSubmitting}
        className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? "Sending..." : "Send magic link"}
      </button>

      {statusMessage ? <p className="text-xs text-emerald-700">{statusMessage}</p> : null}
      {errorMessage ? <p className="text-xs text-rose-700">{errorMessage}</p> : null}
    </form>
  );
};
