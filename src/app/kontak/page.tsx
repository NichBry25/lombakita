import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui";
import { COMPANY } from "@/config/company";

export const metadata: Metadata = {
  title: "Kontak · Lombakita",
  description:
    "Identitas badan usaha, alamat, email, dan nomor telepon resmi yang mengoperasikan Lombakita.",
};

/**
 * Who operates Lombakita, and how to reach them.
 *
 * A definition list rather than prose: someone arrives here to copy one value, usually the email
 * or the account of record for a dispute, and a value inside a sentence is harder to pick out and
 * easier to mistype. The same shape the payment instructions card uses, for the same reason.
 */
export default function ContactPage() {
  return (
    <main>
      <section className="brand-band document-hero">
        <div className="content-shell document-hero-inner">
          <h1>Kontak</h1>
          <p>
            Lombakita dioperasikan oleh badan usaha di bawah ini. Gunakan salah satu jalur berikut
            untuk pertanyaan, keluhan, atau sengketa terkait layanan.
          </p>
        </div>
      </section>

      <div className="page-shell document-page">
        <section className="surface-card card-padding-lg stack-md">
          <h2 className="section-title">Identitas penyelenggara sistem</h2>
          <dl className="detail-grid">
            <div>
              <dt>Nama badan usaha</dt>
              <dd>{COMPANY.legalName}</dd>
            </div>
            <div>
              <dt>Alamat terdaftar</dt>
              <dd>{COMPANY.address}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a>
              </dd>
            </div>
            <div>
              <dt>Telepon</dt>
              <dd>
                <a className="data-text" href={`tel:${COMPANY.phoneDial}`}>
                  {COMPANY.phoneDisplay}
                </a>
              </dd>
            </div>
            <div>
              <dt>NIB</dt>
              <dd className="data-text">{COMPANY.nib}</dd>
            </div>
          </dl>
        </section>

        <section className="surface-card card-padding-lg stack-md">
          <div className="stack-xs">
            <p className="eyebrow">Sebelum menghubungi</p>
            <h2 className="section-title">Hal yang diurus penyelenggara kompetisi</h2>
          </div>
          <div className="document-clause stack-sm">
            <p>
              Biaya pendaftaran ditetapkan dan diterima langsung oleh institusi penyelenggara
              kompetisi, bukan oleh Lombakita. Pertanyaan tentang jumlah biaya, verifikasi bukti
              transfer, jadwal, penilaian, dan hasil lomba dijawab oleh penyelenggara kompetisi yang
              bersangkutan.
            </p>
            <p>
              Hubungi kami untuk hal yang berkaitan dengan akun, penangguhan akun, data pribadi
              Anda, atau jika penyelenggara kompetisi tidak dapat dihubungi.
            </p>
          </div>
        </section>

        <ButtonLink href="/" variant="outline">
          Kembali ke beranda
        </ButtonLink>
      </div>
    </main>
  );
}
