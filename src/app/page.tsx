import Link from "next/link";
import { ButtonLink, Icon } from "@/components/ui";

const DISCOVERY_CATEGORIES = [
  { label: "Teknologi", detail: "Hackathon, produk digital, dan inovasi" },
  { label: "Bisnis", detail: "Studi kasus, rencana bisnis, dan pitching" },
  { label: "Sains", detail: "Riset, olimpiade, dan karya ilmiah" },
  { label: "Seni & kreasi", detail: "Desain, film, fotografi, dan karya visual" },
] as const;

const TRUST_MARKERS = [
  "Informasi terstruktur",
  "Tenggat yang jelas",
  "Alur pendaftaran terpadu",
] as const;

export default function HomePage() {
  return (
    <main>
      <section className="brand-band home-hero">
        <div className="content-shell home-hero-inner">
          <div className="home-hero-copy stack-md">
            <p className="home-kicker">
              <Icon name="trophy" size="sm" />
              Platform peluang mahasiswa Indonesia
            </p>
            <p className="home-brand-word">Lombakita</p>
            <h1>Temukan panggung yang tepat untuk langkah berikutmu.</h1>
            <p className="home-hero-lead">
              Jelajahi kompetisi dengan informasi yang jernih, tenggat yang tegas, dan penyelenggara
              yang dapat kamu kenali.
            </p>
            <ButtonLink href="/auth/login" variant="gold" size="sm">
              Login atau daftar akun
            </ButtonLink>
          </div>

          <Link href="/competitions" className="glass-focus home-search-entry">
            <span className="home-search-icon" aria-hidden="true">
              <Icon name="search" size="lg" />
            </span>
            <span className="home-search-copy">
              <span className="home-search-label">Cari kompetisi</span>
              <span>Nama, kategori, atau penyelenggara</span>
            </span>
            <span className="ui-button" data-variant="gold" data-size="lg">
              Mulai mencari
              <Icon name="arrow-right" size="md" />
            </span>
          </Link>

          <div className="home-trust-row" aria-label="Keunggulan penemuan peluang">
            {TRUST_MARKERS.map((marker) => (
              <span key={marker}>
                <Icon name="check" size="sm" />
                {marker}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="content-shell stack-lg">
          <header className="home-section-header">
            <div className="stack-xs">
              <p className="eyebrow">Jelajahi berdasarkan minat</p>
              <h2 className="section-title">Satu tempat untuk beragam arena</h2>
            </div>
            <ButtonLink href="/competitions" variant="outline" size="sm">
              Lihat semua kompetisi
              <Icon name="arrow-right" size="sm" />
            </ButtonLink>
          </header>

          <div className="home-category-grid">
            {DISCOVERY_CATEGORIES.map((category, index) => (
              <article className="home-category-card" key={category.label}>
                <span className="home-category-index data-text">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="stack-xs">
                  <h3>{category.label}</h3>
                  <p>{category.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="page-section home-guidance-section">
        <div className="content-shell home-guidance-grid">
          <div className="stack-md">
            <p className="eyebrow">Untuk kandidat</p>
            <h2 className="section-title">Fokus pada keputusan, bukan kebisingan.</h2>
            <p className="lead-copy">
              Bandingkan kategori, format partisipasi, jadwal, dan biaya sebelum membuka detail.
              Simpan peluang yang relevan untuk dibaca kembali.
            </p>
            <div className="cluster">
              <ButtonLink href="/competitions" variant="primary">
                Jelajahi kompetisi
              </ButtonLink>
              <ButtonLink href="/saved" variant="ghost">
                Buka yang tersimpan
              </ButtonLink>
            </div>
          </div>

          <div className="home-guidance-list">
            {[
              ["01", "Temukan", "Gunakan pencarian dan filter untuk mempersempit arena."],
              ["02", "Pahami", "Baca jadwal, format, biaya, dan ketentuan utama."],
              ["03", "Bertindak", "Masuk sebagai kandidat dan lanjutkan ke alur pendaftaran."],
            ].map(([number, title, detail]) => (
              <div className="home-guidance-item" key={number}>
                <span className="data-text">{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="content-shell">
          <div className="brand-band home-organizer-cta">
            <div className="stack-sm">
              <p className="eyebrow">Untuk penyelenggara</p>
              <h2>Bangun ruang kompetisi yang dipercaya peserta.</h2>
              <p>
                Kelola publikasi, peserta, submission, dan hasil melalui satu ruang kerja institusi.
              </p>
            </div>
            <ButtonLink href="/institution/workspace" variant="gold" size="lg" prefetch={false}>
              Buka ruang kerja
              <Icon name="arrow-right" size="md" />
            </ButtonLink>
          </div>
        </div>
      </section>
    </main>
  );
}
