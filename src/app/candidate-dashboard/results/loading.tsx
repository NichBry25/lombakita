import { ListPageSkeleton } from "@/components/ui";

export default function CandidateResultsLoading() {
  return <ListPageSkeleton label="Memuat hasil" withFilters={false} />;
}
