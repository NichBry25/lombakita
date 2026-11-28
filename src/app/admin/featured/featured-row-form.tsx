"use client";

import { useState } from "react";
import { Button, CheckboxField, FormInput } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";

const FEATURED_ERROR_COPY: Partial<Record<string, string>> = {
  invalid_competition_id: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  invalid_body: "Urutan harus berupa bilangan bulat.",
  competition_not_found: "Kompetisi tidak ditemukan.",
  competition_not_published:
    "Hanya kompetisi berstatus terbit yang dapat dijadikan unggulan. Muat ulang halaman untuk melihat status terbaru.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  operator_actor_conflicted:
    "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
};

const FEATURED_SAVE_FALLBACK = "Pengaturan unggulan gagal disimpan. Coba lagi.";

type FeaturedRowFormProps = {
  competitionId: string;
  initialIsFeatured: boolean;
  initialFeaturedOrder: number | null;
};

export function FeaturedRowForm({
  competitionId,
  initialIsFeatured,
  initialFeaturedOrder,
}: FeaturedRowFormProps) {
  const { addToast } = useToast();
  const [isFeatured, setIsFeatured] = useState(initialIsFeatured);
  const [featuredOrder, setFeaturedOrder] = useState<string>(
    initialFeaturedOrder !== null ? String(initialFeaturedOrder) : "",
  );
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    const parsedOrder = featuredOrder.trim() === "" ? null : parseInt(featuredOrder.trim(), 10);

    if (featuredOrder.trim() !== "" && (isNaN(parsedOrder!) || !Number.isInteger(parsedOrder))) {
      addToast({ type: "error", message: "Urutan harus berupa bilangan bulat." });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch(`/api/platform-ops/competitions/${competitionId}/featured`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isFeatured, featuredOrder: parsedOrder }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast({
          type: "error",
          message: errorMessageFor(data?.error?.code, FEATURED_ERROR_COPY, FEATURED_SAVE_FALLBACK),
        });
        return;
      }
      setIsFeatured(data.isFeatured);
      setFeaturedOrder(data.featuredOrder !== null ? String(data.featuredOrder) : "");
      addToast({ type: "success", message: "Pengaturan unggulan disimpan." });
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="featured-row-form">
      <CheckboxField checked={isFeatured} onChange={(e) => setIsFeatured(e.target.checked)}>
        Unggulan
      </CheckboxField>
      <FormInput
        type="number"
        value={featuredOrder}
        onChange={(e) => setFeaturedOrder(e.target.value)}
        placeholder="Urutan"
        aria-label="Urutan unggulan"
        className="featured-order-input"
      />
      <Button type="submit" loading={saving} size="sm">
        Simpan
      </Button>
    </form>
  );
}
