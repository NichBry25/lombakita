import { notFound } from "next/navigation";
import { DevPrimitivesClient } from "./dev-primitives-client";

export default function DevPrimitivesPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <main className="page-shell stack-lg">
      <header className="stack-sm">
        <p className="eyebrow">Brandbook v2 foundation</p>
        <h1 className="display-title">Token dan komponen produksi</h1>
        <p className="lead-copy">
          Halaman verifikasi visual khusus development untuk warna, tipografi, surface, kontrol,
          feedback, dan loading.
        </p>
      </header>
      <DevPrimitivesClient />
    </main>
  );
}
