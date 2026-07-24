"use client";

import {
  Button,
  Card,
  Feedback,
  FormField,
  FormHelp,
  FormInput,
  FormLabel,
  FormSelect,
  FormTextarea,
  Skeleton,
  SkeletonCard,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";

export function DevPrimitivesClient() {
  const { openModal } = useModal();
  const { addToast } = useToast();

  function openTwoActionModal() {
    openModal({
      title: "Konfirmasi tindakan",
      body: "Apakah Anda yakin ingin melanjutkan? Tindakan ini tidak dapat dibatalkan.",
      onClose: () => console.log("[dev] modal onClose fired"),
      actions: [
        {
          label: "Konfirmasi",
          variant: "primary",
          autoClose: true,
          onClick: () => console.log("[dev] Confirm clicked"),
        },
        {
          label: "Batal",
          variant: "secondary",
          autoClose: true,
          onClick: () => console.log("[dev] Cancel clicked"),
        },
      ],
    });
  }

  function openNoCloseModal() {
    openModal({
      title: "Modal tanpa tombol tutup",
      body: "Modal ini tidak memiliki tombol ×. Gunakan salah satu tombol aksi di bawah.",
      closeable: false,
      onClose: () => console.log("[dev] no-close modal onClose fired"),
      actions: [
        {
          label: "Mengerti",
          variant: "primary",
          autoClose: true,
          onClick: () => console.log("[dev] Understood clicked"),
        },
      ],
    });
  }

  return (
    <div className="primitive-showcase">
      <section className="stack-md">
        <div className="stack-xs">
          <p className="eyebrow">Warna semantik</p>
          <h2 className="section-title">Palet Brandbook v2</h2>
        </div>
        <div className="token-swatch-grid">
          {[
            ["palm", "Deep Palm"],
            ["tangerine", "Tangerine"],
            ["paper", "Warm paper"],
            ["surface", "Surface"],
            ["ink", "Ink"],
            ["lime", "Stabilo Lime"],
          ].map(([token, label]) => (
            <div className="token-swatch" key={token}>
              <span className="token-swatch-color" data-token={token} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="stack-md">
        <div className="stack-xs">
          <p className="eyebrow">Kontrol</p>
          <h2 className="section-title">Tombol dan status</h2>
        </div>
        <div className="cluster">
          <Button variant="primary">Aksi utama</Button>
          <Button variant="secondary">Aksi sekunder</Button>
          <Button variant="outline">Aksi sekunder</Button>
          <Button variant="ghost">Aksi tenang</Button>
          <Button variant="danger">Aksi destruktif</Button>
          <Button disabled>Nonaktif</Button>
          <Button loading>Memuat</Button>
        </div>
      </section>

      <section className="stack-md">
        <div className="stack-xs">
          <p className="eyebrow">Surface hierarchy</p>
          <h2 className="section-title">Opaque untuk membaca, glass untuk chrome</h2>
        </div>
        <div className="primitive-surface-grid">
          <Card>
            <h3>Surface baca</h3>
            <p className="muted-copy">
              Kartu konten tetap opaque agar teks selalu tenang dan terbaca.
            </p>
          </Card>
          <div className="glass-chrome primitive-surface-sample">
            <h3>Chrome glass</h3>
            <p className="muted-copy">Untuk header, filter, dan rel kontrol.</p>
          </div>
          <div className="glass-focus primitive-surface-sample">
            <h3>Focus glass</h3>
            <p className="muted-copy">Untuk pencarian dan panel konversi utama.</p>
          </div>
          <div className="glass-overlay primitive-surface-sample">
            <h3>Overlay glass</h3>
            <p className="muted-copy">Untuk ringkasan mengambang yang terpilih.</p>
          </div>
        </div>
      </section>

      <section className="primitive-columns">
        <div className="stack-md">
          <div className="stack-xs">
            <p className="eyebrow">Form</p>
            <h2 className="section-title">Keadaan kontrol</h2>
          </div>
          <Card>
            <div className="stack-md">
              <FormField>
                <FormLabel htmlFor="dev-name" required>
                  Nama kompetisi
                </FormLabel>
                <FormInput id="dev-name" placeholder="Contoh: Lomba Esai Nusantara" />
                <FormHelp>Gunakan nama publik yang mudah dikenali.</FormHelp>
              </FormField>
              <FormField>
                <FormLabel htmlFor="dev-category">Kategori</FormLabel>
                <FormSelect id="dev-category" defaultValue="essay">
                  <option value="essay">Esai</option>
                  <option value="business">Bisnis</option>
                </FormSelect>
              </FormField>
              <FormField>
                <FormLabel htmlFor="dev-notes">Catatan</FormLabel>
                <FormTextarea id="dev-notes" placeholder="Tambahkan konteks singkat…" />
              </FormField>
              <FormField>
                <FormLabel htmlFor="dev-readonly">ID institusi</FormLabel>
                <FormInput id="dev-readonly" value="INST-0241" readOnly />
              </FormField>
              <FormField>
                <FormLabel htmlFor="dev-disabled">Kontrol nonaktif</FormLabel>
                <FormInput id="dev-disabled" value="Tidak dapat diubah" disabled />
              </FormField>
            </div>
          </Card>
        </div>

        <div className="stack-md">
          <div className="stack-xs">
            <p className="eyebrow">Feedback</p>
            <h2 className="section-title">Pesan sistem</h2>
          </div>
          <div className="stack-sm">
            <Feedback tone="success">Perubahan berhasil disimpan.</Feedback>
            <Feedback tone="warning">Periksa tenggat sebelum melanjutkan.</Feedback>
            <Feedback tone="error">Dokumen belum lengkap.</Feedback>
            <Feedback tone="info">Data akan ditinjau oleh tim operasi.</Feedback>
          </div>
          <div className="cluster">
            <Button variant="outline" size="sm" onClick={openTwoActionModal}>
              Modal dua aksi
            </Button>
            <Button variant="outline" size="sm" onClick={openNoCloseModal}>
              Modal terkunci
            </Button>
          </div>
          <div className="cluster">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => addToast({ message: "Terjadi kesalahan. Coba lagi.", type: "error" })}
            >
              Toast error
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => addToast({ message: "Operasi berhasil.", type: "success" })}
            >
              Toast sukses
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => addToast({ message: "Informasi tambahan tersedia.", type: "info" })}
            >
              Toast info
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                addToast({ message: "Perhatikan langkah berikutnya.", type: "warning" })
              }
            >
              Toast peringatan
            </Button>
          </div>
        </div>
      </section>

      <section className="stack-md">
        <div className="stack-xs">
          <p className="eyebrow">Loading</p>
          <h2 className="section-title">Skeleton yang tenang</h2>
        </div>
        <div className="primitive-skeleton-grid">
          <SkeletonCard />
          <div className="surface-card card-padding stack-md">
            <div className="cluster">
              <Skeleton variant="avatar" />
              <div className="primitive-skeleton-copy stack-xs">
                <Skeleton variant="title" />
                <Skeleton />
              </div>
            </div>
            <Skeleton variant="media" />
          </div>
        </div>
      </section>
    </div>
  );
}
