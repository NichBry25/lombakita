"use client";

import { useRouter } from "next/navigation";

type Props = {
  path: string;
  status: string;
  type: string;
};

export function ParticipantsFilterForm({ path, status, type }: Props) {
  const router = useRouter();

  const push = (next: { status: string; type: string }) => {
    const params = new URLSearchParams();
    if (next.status !== "all") params.set("status", next.status);
    if (next.type !== "all") params.set("type", next.type);
    const qs = params.toString();
    router.push(qs ? `${path}?${qs}` : path);
  };

  return (
    <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <label>
        Status:{" "}
        <select
          value={status}
          onChange={(e) => push({ status: e.target.value, type })}
        >
          <option value="all">Semua</option>
          <option value="confirmed">Dikonfirmasi</option>
          <option value="cancelled">Dibatalkan</option>
        </select>
      </label>
      <label>
        Tipe:{" "}
        <select
          value={type}
          onChange={(e) => push({ status, type: e.target.value })}
        >
          <option value="all">Semua</option>
          <option value="individual">Individu</option>
          <option value="team">Tim</option>
        </select>
      </label>
    </div>
  );
}
