import { TablePageSkeleton } from "@/components/ui";

export default function AuditLogLoading() {
  return <TablePageSkeleton label="Memuat log audit" rows={8} columns={5} />;
}
