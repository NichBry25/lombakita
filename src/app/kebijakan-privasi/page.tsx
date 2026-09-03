import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY, LEGAL_DOCUMENT } from "@/config/company";

export const metadata: Metadata = {
  title: "Kebijakan Privasi · Lombakita",
  description:
    "Data apa yang Lombakita simpan, berapa lama disimpan, pihak mana yang menerimanya, dan bagaimana cara meminta penghapusan.",
};

/**
 * The privacy policy.
 *
 * Written against the schema, the upload paths, the retention job and the connector list as they
 * exist today, not against what the product intends to do later. The retention section says
 * plainly where no automatic deletion runs, because the alternative is a promise of a period that
 * no job enforces. `docs/legal/clause-provenance.md` maps each section to the code behind it.
 */
export default function PrivacyPage() {
  return (
    <main>
      <section className="brand-band document-hero">
        <div className="content-shell document-hero-inner">
          <h1>Kebijakan Privasi</h1>
          <p>
            Halaman ini menjelaskan data yang kami simpan, alasannya, berapa lama disimpan, dan
            siapa saja yang menerimanya.
          </p>
          <p className="document-meta">
            <span>Versi {LEGAL_DOCUMENT.version}</span>
            <span>Berlaku sejak {LEGAL_DOCUMENT.effectiveDateLabel}</span>
          </p>
        </div>
      </section>

      <div className="page-shell document-page">
        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">1. Siapa yang mengelola data Anda</h2>
          <p>
            Data pada layanan ini dikelola oleh {COMPANY.legalName}, alamat {COMPANY.address}. Untuk
            pertanyaan tentang data pribadi Anda, hubungi{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a>.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">2. Data akun</h2>
          <p>Untuk setiap akun kami menyimpan:</p>
          <ul className="document-list">
            <li>alamat email dan status verifikasi email;</li>
            <li>nama dan nama pengguna;</li>
            <li>foto dari akun Google, jika Anda mendaftar dengan Google;</li>
            <li>peran akun, status akun, serta waktu verifikasi peran kandidat dan rekruter;</li>
            <li>tingkat verifikasi rekruter, untuk akun penyelenggara;</li>
            <li>
              status penangguhan dan alasannya, jika akun Anda pernah ditangguhkan oleh tim kami;
            </li>
            <li>waktu pembuatan dan pembaruan akun.</li>
          </ul>
          <p>
            Password disimpan dalam bentuk teracak dan tidak dapat dibaca kembali oleh siapa pun,
            termasuk oleh kami.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">3. Data profil</h2>
          <p>
            Saat mendaftar sebagai peserta, Anda mengisi nama lengkap, nomor telepon, status saat
            ini, dan tanggal lahir.
          </p>
          <p>
            Profil publik Anda dapat memuat nama tampilan, nomor telepon, foto profil, sampul,
            ringkasan diri, lokasi, dan CV. Anda juga dapat menambahkan pengalaman, pendidikan,
            keahlian, sertifikasi, dan tautan media sosial. Semua bagian ini Anda isi sendiri dan
            dapat Anda ubah atau kosongkan melalui halaman profil.
          </p>
          <p>
            CV Anda bersifat tertutup kecuali Anda sendiri yang menandainya boleh tampil di profil
            publik.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">4. Berkas yang Anda unggah</h2>
          <p>
            Berkas disimpan pada layanan penyimpanan objek Cloudflare R2 dan tidak dapat diakses
            melalui tautan publik yang permanen. Ketika sebuah berkas perlu ditampilkan, sistem
            membuat tautan sementara yang berlaku singkat. Jenis berkas yang kami simpan:
          </p>
          <ul className="document-list">
            <li>foto profil, sampul profil, dan CV;</li>
            <li>berkas sertifikasi pada profil Anda;</li>
            <li>logo dan sampul institusi, untuk akun penyelenggara;</li>
            <li>gambar QRIS pembayaran yang diunggah penyelenggara;</li>
            <li>dokumen yang diminta penyelenggara pada sebuah kompetisi;</li>
            <li>dokumen verifikasi institusi dan dokumen verifikasi rekruter;</li>
            <li>bukti transfer, termasuk bukti transfer yang pernah Anda kirim sebelumnya.</li>
          </ul>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">5. Berapa lama data disimpan</h2>
          <p>
            Bagian ini menyebutkan apa adanya. Ada dua jenis berkas yang dihapus otomatis, dan ada
            yang tidak dihapus otomatis sama sekali.
          </p>
          <p>
            <strong>Dihapus otomatis.</strong> Sebuah tugas terjadwal berjalan berkala dan
            menghapus:
          </p>
          <ul className="document-list">
            <li>
              karya yang diunggah tetapi tidak pernah difinalisasi sebagai karya peserta, 90 hari
              setelah kompetisi berakhir. Karya yang sudah difinalisasi tidak pernah dihapus oleh
              tugas ini, karena karya itulah dasar penilaian dan hasil lomba;
            </li>
            <li>
              dokumen yang diminta penyelenggara pada sebuah kompetisi, 90 hari setelah kompetisi
              berakhir.
            </li>
          </ul>
          <p>
            <strong>Tidak dihapus otomatis.</strong> Untuk berkas berikut tidak ada tugas
            penghapusan otomatis, sehingga berkas tersebut tersimpan sampai dihapus atas permintaan:
          </p>
          <ul className="document-list">
            <li>foto profil, sampul profil, CV, dan berkas sertifikasi;</li>
            <li>logo dan sampul institusi serta gambar QRIS;</li>
            <li>dokumen verifikasi institusi dan dokumen verifikasi rekruter.</li>
          </ul>
          <p>
            Bukti transfer disimpan sebagai catatan keuangan selama masih diperlukan untuk keperluan
            pembukuan dan penyelesaian sengketa pembayaran, termasuk bukti transfer dari percobaan
            sebelumnya.
          </p>
          <p>
            Data akun dan profil disimpan selama akun Anda ada. Untuk meminta penghapusan data atau
            berkas tertentu, hubungi{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a>.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">6. Pihak lain yang menerima data</h2>
          <p>
            Kami tidak menjual data Anda. Data Anda diproses oleh penyedia layanan berikut sebatas
            untuk menjalankan Lombakita:
          </p>
          <ul className="document-list">
            <li>Neon, basis data tempat data akun dan profil disimpan;</li>
            <li>Vercel, tempat aplikasi web ini dijalankan;</li>
            <li>Railway, tempat proses latar belakang seperti pengiriman email dijalankan;</li>
            <li>Cloudflare R2, tempat berkas disimpan;</li>
            <li>Resend, yang mengirimkan email dari layanan ini dan menerima alamat tujuannya;</li>
            <li>
              Meilisearch, mesin pencarian yang memuat data kompetisi yang memang sudah publik;
            </li>
            <li>Redis, untuk antrean pekerjaan dan pembatasan laju permintaan;</li>
            <li>Sentry, yang menerima laporan galat teknis ketika terjadi kesalahan sistem;</li>
            <li>
              Google, jika Anda memilih masuk dengan akun Google. Dalam hal itu kami menerima nama,
              alamat email, dan status verifikasi email Anda dari Google.
            </li>
          </ul>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">7. Sesi masuk</h2>
          <p>
            Setelah masuk, sesi Anda disimpan pada cookie di peramban dalam bentuk token
            bertandatangan. Token itu memuat pengenal akun, peran, peran yang sudah terverifikasi,
            waktu aktif terakhir, penanda apakah tawaran peran kedua sudah Anda tutup, dan waktu
            verifikasi dua faktor jika akun Anda memakainya.
          </p>
          <p>
            Masa berlaku sesi adalah satu tahun dan diperbarui paling banyak sekali sehari setiap
            kali sesi dibaca. Selama Anda kembali dalam rentang itu, sesi Anda tetap hidup dan Anda
            tidak perlu masuk lagi. Anda dapat mengakhiri sesi kapan saja dengan keluar dari akun.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">8. Analitik dan pelacakan</h2>
          <p>
            Tidak ada. Lombakita tidak memuat skrip analitik atau pelacak pihak ketiga di halaman
            publiknya, dan tidak memasang cookie untuk keperluan iklan atau profil perilaku. Cookie
            yang dipakai hanya cookie sesi yang dijelaskan pada bagian 7.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">9. Hak Anda</h2>
          <p>
            Anda dapat melihat dan mengubah sebagian besar data Anda sendiri melalui halaman profil.
            Menghapus sebuah berkas di halaman profil akan menghilangkannya dari profil Anda;
            salinan yang tersimpan pada penyimpanan kami dihapus melalui permintaan pada alamat di
            bawah.
          </p>
          <p>
            Untuk meminta salinan data Anda, memperbaiki data yang keliru, atau meminta penghapusan
            akun beserta berkasnya, hubungi{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a> dari alamat email
            akun Anda, agar kami dapat memastikan permintaan itu datang dari pemilik akun.
          </p>
          <p>
            Kami menyampaikan apa adanya: permintaan seperti ini ditangani secara manual oleh tim
            kami, satu per satu. Belum ada tombol atau proses otomatis di dalam aplikasi untuk
            menghapus akun, dan kami tidak menjanjikan batas waktu penyelesaian. Kami akan
            memberitahu Anda apa yang kami lakukan atas permintaan Anda.
          </p>
        </section>

        <section className="surface-card card-padding-lg stack-md document-clause">
          <h2 className="section-title">10. Perubahan kebijakan</h2>
          <p>
            Kebijakan ini dapat berubah seiring perubahan produk. Versi dan tanggal berlaku
            tercantum di bagian atas halaman ini. Ketentuan penggunaan layanan ada pada halaman{" "}
            <Link href="/syarat-ketentuan">Syarat & Ketentuan</Link>, dan keterangan badan usaha ada
            pada halaman <Link href="/kontak">Kontak</Link>.
          </p>
        </section>
      </div>
    </main>
  );
}
