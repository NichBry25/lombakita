"use client";

import { useRouter } from "next/navigation";
import { FilterDropdown } from "@/components/ui";

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
    <div className="participant-filter-toolbar glass-chrome">
      <FilterDropdown
        label="Status"
        value={status}
        onChange={(value) => push({ status: value, type })}
        options={[
          { value: "all", label: "Semua" },
          { value: "confirmed", label: "Dikonfirmasi" },
          { value: "cancelled", label: "Dibatalkan" },
        ]}
      />
      <FilterDropdown
        label="Tipe"
        value={type}
        onChange={(value) => push({ status, type: value })}
        options={[
          { value: "all", label: "Semua" },
          { value: "individual", label: "Individu" },
          { value: "team", label: "Tim" },
        ]}
      />
    </div>
  );
}
