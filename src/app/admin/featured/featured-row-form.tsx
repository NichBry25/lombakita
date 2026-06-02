"use client";

import { useState } from "react";

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
  const [isFeatured, setIsFeatured] = useState(initialIsFeatured);
  const [featuredOrder, setFeaturedOrder] = useState<string>(
    initialFeaturedOrder !== null ? String(initialFeaturedOrder) : "",
  );
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("saving");
    setErrorMsg(null);

    const parsedOrder =
      featuredOrder.trim() === "" ? null : parseInt(featuredOrder.trim(), 10);

    if (featuredOrder.trim() !== "" && (isNaN(parsedOrder!) || !Number.isInteger(parsedOrder))) {
      setStatus("error");
      setErrorMsg("Urutan harus berupa bilangan bulat.");
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
        setStatus("error");
        setErrorMsg(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      setIsFeatured(data.isFeatured);
      setFeaturedOrder(data.featuredOrder !== null ? String(data.featuredOrder) : "");
      setStatus("ok");
    } catch {
      setStatus("error");
      setErrorMsg("Terjadi kesalahan jaringan.");
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
        disabled={status === "saving"}
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "none",
          background: "#355795",
          color: "#fff",
          fontSize: 12,
          cursor: status === "saving" ? "not-allowed" : "pointer",
        }}
      >
        {status === "saving" ? "..." : "Simpan"}
      </button>
      {status === "ok" && (
        <span style={{ color: "#155724", fontSize: 12 }}>✓</span>
      )}
      {status === "error" && (
        <span style={{ color: "#721c24", fontSize: 12 }}>{errorMsg}</span>
      )}
    </form>
  );
}
