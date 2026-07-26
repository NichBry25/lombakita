import { TablePageSkeleton } from "@/components/ui";

export default function InstitutionMembersLoading() {
  return <TablePageSkeleton label="Memuat anggota" columns={4} withFilters={false} />;
}
