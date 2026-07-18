import { ButtonLink, Icon } from "@/components/ui";

const SUPPORT_EMAIL = "dukungan@lombakita.id";

export default function SuspendedPage() {
  return (
    <main>
      <section className="brand-band suspension-hero">
        <div className="content-shell suspension-hero-inner">
          <span className="suspension-mark" aria-hidden="true">
            !
          </span>
          <div className="stack-sm">
            <p className="eyebrow">Status akun</p>
            <h1>Akun Anda ditangguhkan</h1>
            <p>
              Akun ini sedang ditangguhkan oleh tim Lombakita, sehingga Anda tidak dapat masuk untuk
              saat ini. Penangguhan dilakukan setelah peninjauan internal.
            </p>
          </div>
        </div>
      </section>

      <div className="page-shell suspension-content">
        <section className="surface-card card-padding-lg stack-md">
          <span className="detail-info-icon" aria-hidden="true">
            <Icon name="inbox" size="lg" />
          </span>
          <div className="stack-sm">
            <h2 className="section-title">Hubungi dukungan</h2>
            <p className="muted-copy">
              Jika Anda merasa penangguhan ini keliru atau ingin mengajukan banding, hubungi tim
              dukungan Lombakita melalui email berikut:
            </p>
            <a className="support-email data-text" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </div>
        </section>

        <section className="surface-card card-padding-lg stack-md">
          <div className="stack-xs">
            <p className="eyebrow">Proses banding</p>
            <h2 className="section-title">Cara mengajukan banding</h2>
          </div>
          <ol className="appeal-steps">
            <li>Kirim email ke alamat dukungan di atas dari alamat email akun Anda.</li>
            <li>Tuliskan nama akun dan jelaskan secara singkat keberatan Anda.</li>
            <li>Tim Lombakita akan meninjau permintaan banding Anda dan membalas melalui email.</li>
          </ol>
        </section>

        <ButtonLink href="/" variant="outline">
          Kembali ke beranda
        </ButtonLink>
      </div>
    </main>
  );
}
