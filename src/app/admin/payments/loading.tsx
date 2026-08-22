import { ListPageSkeleton } from "@/components/ui";

export default function Loading() {
  return <ListPageSkeleton label="Memuat pembayaran tertahan" withFilters={false} />;
}
