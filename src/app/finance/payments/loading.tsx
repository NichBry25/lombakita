import { TablePageSkeleton } from "@/components/ui";

export default function Loading() {
  return <TablePageSkeleton label="Memuat sengketa pembayaran" withFilters={false} columns={5} />;
}
