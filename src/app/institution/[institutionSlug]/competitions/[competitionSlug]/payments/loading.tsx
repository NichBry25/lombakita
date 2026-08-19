import { ListPageSkeleton } from "@/components/ui";

// A card list, not a table, and no filter row on this surface — the queue is one competition's
// proofs in full.
export default function CompetitionPaymentsLoading() {
  return <ListPageSkeleton label="Memuat bukti transfer" cards={4} withFilters={false} />;
}
