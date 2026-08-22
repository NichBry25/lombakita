import { TablePageSkeleton } from "@/components/ui";

export default function Loading() {
  return <TablePageSkeleton label="Memuat tagihan biaya layanan" withFilters={false} columns={5} />;
}
