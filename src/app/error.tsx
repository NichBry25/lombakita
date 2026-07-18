"use client";

import { useEffect } from "react";
import { Button, Icon } from "@/components/ui";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page-shell app-page system-state-page">
      <section className="system-state-card brand-band">
        <span className="system-state-icon" aria-hidden="true">
          <Icon name="close" size="xl" />
        </span>
        <p className="eyebrow">Gangguan sementara</p>
        <h1>Terjadi kesalahan.</h1>
        <p>Coba muat ulang halaman. Jika masalah berlanjut, hubungi dukungan Lombakita.</p>
        <Button type="button" onClick={reset} variant="gold">
          Coba lagi
        </Button>
      </section>
    </main>
  );
}
