"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/primitives";

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

    const parsedOrder =
      featuredOrder.trim() === "" ? null : parseInt(featuredOrder.trim(), 10);

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
        addToast({ type: "error", message: data?.error?.message ?? `Error ${res.status}` });
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
    <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={isFeatured}
          onChange={(e) => setIsFeatured(e.target.checked)}
        />
        Unggulan
      </label>
      <input
        type="number"
        value={featuredOrder}
        onChange={(e) => setFeaturedOrder(e.target.value)}
        placeholder="Urutan"
        aria-label="Urutan unggulan"
        style={{ width: 70, padding: "3px 6px", borderRadius: 4, border: "1px solid #ccc", fontSize: 12 }}
      />
      <button
        type="submit"
        disabled={saving}
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "none",
          background: "#355795",
          color: "#fff",
          fontSize: 12,
          cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "..." : "Simpan"}
      </button>
    </form>
  );
}
