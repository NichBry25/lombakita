"use client";

import { useRouter } from "next/navigation";
import { SelectField } from "@/components/ui";

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
      <div className="form-field">
        <span className="form-label">Status</span>
        <SelectField
          label="Status"
          value={status}
          onChange={(value) => push({ status: value, type })}
          options={[
            { value: "all", label: "Semua" },
            { value: "confirmed", label: "Dikonfirmasi" },
            { value: "cancelled", label: "Dibatalkan" },
          ]}
        />
      </div>
      <div className="form-field">
        <span className="form-label">Tipe</span>
        <SelectField
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
    </div>
  );
}
