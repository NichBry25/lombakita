import { TablePageSkeleton } from "@/components/ui";

export default function ParticipantsLoading() {
  return <TablePageSkeleton label="Memuat peserta" rows={8} columns={5} />;
}
