import { ButtonLink, Icon } from "@/components/ui";

export default function NotFoundPage() {
  return (
    <main className="page-shell app-page system-state-page">
      <section className="system-state-card brand-band">
        <span className="system-state-icon" aria-hidden="true">
          <Icon name="search" size="xl" />
        </span>
        <p className="eyebrow">404</p>
        <h1>Halaman tidak ditemukan.</h1>
        <p>Alamat yang Anda buka tidak tersedia atau sudah dipindahkan.</p>
        <ButtonLink href="/competitions" variant="gold">
          Jelajahi kompetisi
        </ButtonLink>
      </section>
    </main>
  );
}
