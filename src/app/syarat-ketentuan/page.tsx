import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY, LEGAL_DOCUMENT } from "@/config/company";

export const metadata: Metadata = {
  title: "Syarat & Ketentuan · Lombakita",
  description:
    "Ketentuan penggunaan Lombakita: siapa yang dapat mendaftar, bagaimana biaya pendaftaran bekerja, dan apa yang menjadi tanggung jawab penyelenggara kompetisi.",
};

/**
 * The terms of service.
 *
 * Every clause here describes behaviour that exists in this codebase today. The mapping from each
 * heading to the behaviour and the decision that backs it is kept in
 * `docs/legal/clause-provenance.md`, so the document can be fact-checked against the product
 * rather than read for plausibility. A clause with nothing behind it does not belong on this page.
 */
export default function TermsPage() {
  return (
    <main>
      <section className="brand-band document-hero">
        <div className="content-shell document-hero-inner">
          <h1>Syarat & Ketentuan</h1>
          <p>
            Ketentuan ini mengatur penggunaan Lombakita oleh peserta dan oleh institusi
            penyelenggara kompetisi.
          </p>
          <p className="document-meta">
            <span>Versi {LEGAL_DOCUMENT.version}</span>
            <span>Berlaku sejak {LEGAL_DOCUMENT.effectiveDateLabel}</span>
          </p>
        </div>
      </section>

      <div className="page-shell document-page">
        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">1. Tentang layanan ini</h2>
          <p>
            Lombakita adalah platform yang mempertemukan peserta dengan kompetisi yang
            diselenggarakan oleh institusi. Layanan ini dioperasikan oleh {COMPANY.legalName}.
          </p>
          <p>
            Lombakita menyediakan tempat kompetisi diumumkan, didaftari, dan dikelola. Kompetisi itu
            sendiri dijalankan oleh institusi penyelenggara, termasuk penilaian dan penentuan
            pemenang.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">2. Siapa yang dapat mendaftar</h2>
          <p>
            Pendaftaran akun terbuka untuk siapa saja. Tidak ada batasan usia, tidak ada syarat
            status pelajar atau mahasiswa, dan tidak ada keharusan berafiliasi dengan kampus mana
            pun. Pelajar, mahasiswa, lulusan baru, dan profesional sama-sama dapat menjadi peserta.
          </p>
          <p>
            Saat mendaftar, Anda melengkapi profil berisi nama lengkap, nomor telepon, status saat
            ini, dan tanggal lahir. Data ini dicatat sebagai keterangan diri Anda dan tidak
            digunakan untuk membatasi kompetisi yang boleh Anda ikuti.
          </p>
          <p>
            Penyelenggara kompetisi dapat menetapkan persyaratannya sendiri di halaman kompetisi.
            Persyaratan itu milik penyelenggara dan dinilai oleh penyelenggara.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">3. Akun dan nama pengguna</h2>
          <p>
            Anda dapat membuat akun dengan email dan password, atau dengan akun Google. Satu alamat
            email hanya dapat dipakai untuk satu akun. Anda bertanggung jawab menjaga kerahasiaan
            password Anda.
          </p>
          <p>
            Sebagian nama pengguna dicadangkan karena akan bertabrakan dengan alamat halaman di
            situs ini, misalnya nama yang sama dengan alamat halaman sistem. Nama pengguna yang
            dicadangkan tidak dapat dipakai.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">4. Peran penyelenggara kompetisi</h2>
          <p>
            Institusi penyelenggara yang menentukan isi kompetisi: jadwal, tahapan, hadiah,
            persyaratan, biaya pendaftaran, dan siapa yang menang. Lombakita tidak menilai peserta
            dan tidak ikut menentukan hasil.
          </p>
          <p>
            Pertanyaan dan keberatan tentang jalannya sebuah kompetisi ditujukan kepada
            penyelenggara kompetisi tersebut.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">5. Biaya pendaftaran dan cara pembayaran</h2>
          <p>
            Sebagian kompetisi memungut biaya pendaftaran. Besaran biaya ditetapkan oleh institusi
            penyelenggara dan dibayarkan langsung kepada institusi tersebut. Lombakita tidak
            menampung, menyimpan, atau meneruskan uang pendaftaran Anda.
          </p>
          <p>Saat ini pembayaran dilakukan melalui transfer manual. Alurnya sebagai berikut:</p>
          <ol className="document-list">
            <li>
              Anda mendaftar, lalu halaman pendaftaran menampilkan rekening tujuan milik
              penyelenggara beserta jumlah yang harus dibayar.
            </li>
            <li>Anda melakukan transfer langsung ke rekening tersebut.</li>
            <li>Anda mengunggah bukti transfer pada halaman pendaftaran Anda.</li>
            <li>
              Institusi penyelenggara yang memeriksa dan memutuskan bukti transfer Anda diterima
              atau ditolak. Keputusan itu bukan keputusan Lombakita.
            </li>
          </ol>
          <p>
            Jika bukti transfer ditolak, alasan penolakan ditampilkan pada halaman pendaftaran Anda.
            Penyelenggara dapat mengizinkan Anda mengirim ulang bukti yang baru.
          </p>
          <p>
            Setiap pembayaran memiliki batas waktu. Selama bukti transfer Anda sedang ditinjau,
            batas waktu itu tidak berjalan. Jika batas waktu terlewat tanpa pembayaran yang
            diterima, pendaftaran dibatalkan secara otomatis.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">
            6. Pembayaran tidak dapat ditarik kembali atas permintaan Anda
          </h2>
          <p>
            Setelah Anda mengirim bukti transfer, pendaftaran berbayar tidak dapat Anda batalkan
            sendiri dan biaya yang sudah dibayarkan tidak dikembalikan atas permintaan Anda. Tombol
            pembatalan tidak ditampilkan pada keadaan ini, karena keputusannya memang sudah tidak
            ada pada Anda.
          </p>
          <p>
            Uangnya ada pada penyelenggara, bukan pada Lombakita. Jika Anda merasa ada kekeliruan,
            hubungi penyelenggara kompetisi. Bila penyelenggara tidak dapat dihubungi, hubungi kami
            melalui jalur pada bagian 12.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">7. Pembatalan kompetisi oleh penyelenggara</h2>
          <p>
            Penyelenggara tidak dapat menarik atau membatalkan sendiri sebuah kompetisi yang sudah
            memiliki pendaftaran berbayar. Sistem menolak tindakan itu.
          </p>
          <p>
            Kompetisi semacam itu hanya dapat dihentikan melalui tim operasional Lombakita, supaya
            ada pihak yang mencatat dan menangani peserta yang sudah membayar.
          </p>
          <p>
            Keadaan ini berbeda dari bagian 6 dan tidak diatur olehnya. Bagian 6 berlaku ketika Anda
            sendiri yang membatalkan; di sini Anda tidak membatalkan apa pun, melainkan kompetisi
            yang Anda bayar tidak jadi berjalan. Karena itu bagian 6 tidak dapat dipakai untuk
            menolak pengembalian biaya Anda dalam keadaan ini.
          </p>
          <p>
            Uang pendaftaran ada pada penyelenggara, bukan pada Lombakita, sehingga penyelesaiannya
            ditangani bersama penyelenggara melalui tim operasional kami. Kami menyampaikan apa
            adanya: saat ini belum ada proses pengembalian dana otomatis di dalam aplikasi, jadi
            penyelesaian dilakukan per kasus. Hubungi kami melalui jalur pada bagian 12.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">8. Dokumen peserta</h2>
          <p>
            Penyelenggara dapat meminta dokumen kepada peserta pada sebuah kompetisi, misalnya untuk
            memeriksa identitas atau memenuhi persyaratan lomba. Permintaan itu berlaku per
            kompetisi dan hanya muncul jika penyelenggara memintanya.
          </p>
          <p>
            Status pemeriksaan dokumen tidak membuka atau menutup akses Anda ke bagian mana pun di
            Lombakita. Dokumen yang diminta adalah urusan antara Anda dan penyelenggara kompetisi
            tersebut.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">9. Penangguhan akun</h2>
          <p>
            Tim Lombakita dapat menangguhkan akun setelah peninjauan internal, misalnya karena
            penyalahgunaan layanan, identitas yang dipalsukan, atau tindakan yang merugikan peserta
            lain maupun penyelenggara.
          </p>
          <p>
            Akun yang ditangguhkan tidak dapat masuk ke Lombakita. Anda akan diarahkan ke halaman
            pemberitahuan yang memuat alamat untuk mengajukan banding. Alasan penangguhan dicatat
            pada sistem kami.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">10. Berkas yang Anda unggah</h2>
          <p>
            Anda dapat mengunggah berkas ke Lombakita, misalnya foto profil, sampul profil, CV,
            sertifikat, dokumen yang diminta penyelenggara, dan bukti transfer. Anda menyatakan
            berhak atas berkas yang Anda unggah.
          </p>
          <p>
            Berkas Anda hanya dipakai untuk menjalankan layanan ini. Rincian tentang penyimpanan dan
            siapa yang dapat melihatnya ada pada{" "}
            <Link href="/kebijakan-privasi">Kebijakan Privasi</Link>.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">11. Batas tanggung jawab</h2>
          <p>
            Lombakita menyediakan tempat kompetisi diumumkan dan dikelola. Kami tidak menampung uang
            pendaftaran, tidak menjalankan penilaian, dan tidak menjamin sebuah kompetisi akan
            berjalan sesuai rencana penyelenggaranya.
          </p>
          <p>
            Kami berusaha menjaga layanan tetap dapat diakses, tetapi tidak menjanjikan layanan
            bebas gangguan.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">12. Perubahan ketentuan dan cara menghubungi kami</h2>
          <p>
            Ketentuan ini dapat berubah seiring perubahan produk. Versi dan tanggal berlaku
            tercantum di bagian atas halaman ini.
          </p>
          <p>
            Untuk pertanyaan, keluhan, atau sengketa yang berkaitan dengan ketentuan ini, hubungi{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a> atau lihat
            keterangan lengkap pada halaman <Link href="/kontak">Kontak</Link>.
          </p>
        </section>
      </div>
    </main>
  );
}
