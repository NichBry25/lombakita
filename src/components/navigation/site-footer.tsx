import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer" id="tentang">
      <div className="footer-inner">
        <div className="stack-sm">
          <h2 className="footer-title">Lombakita.id</h2>
          <p className="footer-copy">
            Mercusuar peluang mahasiswa Indonesia: temukan kompetisi yang kredibel, pahami
            persyaratannya, lalu melangkah dengan yakin.
          </p>
        </div>
        <div className="footer-links">
          <h3>Jelajahi</h3>
          <Link href="/competitions">Semua kompetisi</Link>
          <Link href="/saved">Kompetisi tersimpan</Link>
          <Link href="/candidate-dashboard">Dashboard kandidat</Link>
        </div>
        <div className="footer-links">
          <h3>Penyelenggara</h3>
          <Link href="/institution/workspace">Ruang kerja institusi</Link>
          <Link href="/recruiter-dashboard">Dashboard penyelenggara</Link>
          <Link href="/profile">Profil dan pengaturan</Link>
        </div>
      </div>
    </footer>
  );
}
