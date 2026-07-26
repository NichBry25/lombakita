import { TablePageSkeleton } from "@/components/ui";

export default function InboxLoading() {
  return <TablePageSkeleton label="Memuat kotak masuk" rows={6} columns={3} withFilters={false} />;
}
