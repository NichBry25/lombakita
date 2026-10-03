import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY } from "@/config/company";
import { INDEXABLE_ROBOTS } from "@/config/indexable-routes";

const TITLE = "Tentang · Lombakita";
const DESCRIPTION =
  "Apa itu Lombakita, cara mendaftar kompetisi, biaya, dan identitas badan usaha yang mengoperasikannya.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: INDEXABLE_ROBOTS,
  alternates: { canonical: "/tentang" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/tentang", type: "website" },
};

/**
 * What Lombakita is, how to register for and publish a competition, what it costs, and who
 * operates it.
 *
 * Static copy that reads the operator's facts from COMPANY, like the contact page, so the identity
 * block here cannot drift from the footer or from /kontak.
 */
export default function AboutPage() {
  return (
    <main>
      <section className="brand-band document-hero">
        <div className="content-shell document-hero-inner">
          <h1>Tentang Lombakita</h1>
          <p>
            Lombakita adalah platform untuk menemukan dan mendaftar kompetisi di Indonesia.
            Penyelenggara menerbitkan kompetisinya di sini, dan peserta mendaftar tanpa pindah
            situs.
          </p>
        </div>
      </section>

      <div className="page-shell document-page">
        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">Layanan kami</h2>
          <p>
            Untuk peserta: jelajahi kompetisi menurut kategori, penyelenggara, dan tenggat, simpan
            yang menarik, lalu daftar langsung dari halaman kompetisi, sebagai individu atau tim.
          </p>
          <p>
            Untuk penyelenggara: institusi membuat ruang kerja, menerbitkan kompetisi, dan mengelola
            pendaftar serta hasilnya. Lombakita tidak menilai peserta dan tidak ikut menentukan
            pemenang.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">Cara mendaftar kompetisi</h2>
          <ol className="document-list">
            <li>Buka halaman kompetisi dan baca persyaratannya.</li>
            <li>Masuk, atau buat akun sebagai peserta.</li>
            <li>Tekan &quot;Daftar kompetisi&quot;, lalu daftar sebagai individu atau buat tim.</li>
            <li>Konfirmasi pendaftaran dikirim ke emailmu.</li>
          </ol>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">Cara menerbitkan kompetisi</h2>
          <ol className="document-list">
            <li>Buat akun sebagai penyelenggara, lalu buat ruang kerja institusi.</li>
            <li>Selesaikan verifikasi penyelenggara.</li>
            <li>Buat draf kompetisi, lengkapi detailnya, lalu terbitkan.</li>
          </ol>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">Biaya dan pembayaran</h2>
          <p>
            Saat ini semua kompetisi di Lombakita gratis untuk diikuti, dan Lombakita tidak memungut
            biaya dari peserta maupun penyelenggara.
          </p>
          <p>
            Pendaftaran berbayar belum tersedia dan akan dibuka kemudian. Bila sudah dibuka, biaya
            pendaftaran ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu
            mendaftar.
          </p>
          <p>
            Biaya dibayarkan kepada penyelenggara, bukan kepada Lombakita. Lombakita tidak
            menampung, menyimpan, atau meneruskan uang pendaftaran. Saat ini pembayaran dilakukan
            lewat transfer manual ke rekening penyelenggara, dengan bukti transfer yang diperiksa
            penyelenggara. Pembayaran online melalui penyedia pembayaran berlisensi akan menyusul.
            Pembayaran online segera hadir.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">Pembatalan dan pengembalian dana</h2>
          <p>
            Biaya pendaftaran yang sudah dibayarkan tidak dikembalikan atas permintaan peserta
            sendiri. Ketentuan lengkap tentang pembatalan kompetisi oleh penyelenggara dan
            pengembalian dana ada di <Link href="/syarat-ketentuan">Syarat &amp; Ketentuan</Link>,
            bagian 5 sampai 7.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">Bantuan</h2>
          <p>
            Pertanyaan tentang jumlah biaya, bukti transfer, jadwal, penilaian, dan hasil lomba
            dijawab oleh penyelenggara kompetisi yang bersangkutan.
          </p>
          <p>
            Untuk masalah akun, penangguhan akun, data pribadi, atau bila penyelenggara tidak dapat
            dihubungi, kirim email ke{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a> atau hubungi{" "}
            <a href={COMPANY.phone.href}>{COMPANY.phone.display}</a>.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md">
          <h2 className="section-title">Identitas badan usaha</h2>
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
              <dt>NIB</dt>
              <dd className="data-text">{COMPANY.nib}</dd>
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
                <a href={COMPANY.phone.href}>{COMPANY.phone.display}</a>
              </dd>
            </div>
          </dl>
          <p>
            <Link href="/kontak">Lihat halaman kontak</Link>
          </p>
        </section>
      </div>
    </main>
  );
}
