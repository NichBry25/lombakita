"use client";

import { useEffect } from "react";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-20">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-zinc-600">Please try again. If the problem continues, contact support.</p>
      <button
        type="button"
        onClick={reset}
        className="w-fit rounded border border-zinc-300 px-4 py-2 text-sm"
      >
        Retry
      </button>
    </main>
  );
}
