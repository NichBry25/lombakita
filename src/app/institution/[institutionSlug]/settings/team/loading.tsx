import { TablePageSkeleton } from "@/components/ui";

export default function InstitutionTeamLoading() {
  return <TablePageSkeleton label="Memuat tim institusi" columns={4} withFilters={false} />;
}
