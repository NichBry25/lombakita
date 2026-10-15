"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button, Icon } from "@/components/ui";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  const router = useRouter();

  useEffect(() => {
    console.error(error);
    if (!error.digest) {
      Sentry.captureException(error);
    }
  }, [error]);

  const retry = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  return (
    <main className="page-shell app-page system-state-page">
      <section className="system-state-card brand-band">
        <span className="system-state-icon" aria-hidden="true">
          <Icon name="close" size="xl" />
        </span>
        <h1>Terjadi kesalahan.</h1>
        <p>Coba muat ulang halaman. Jika masalah berlanjut, hubungi dukungan Lombakita.</p>
        <Button type="button" onClick={retry} variant="secondary">
          Coba lagi
        </Button>
      </section>
    </main>
  );
}
