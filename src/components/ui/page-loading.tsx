import { Skeleton, SkeletonCard } from "./skeleton";

export function PageLoading({ label = "Memuat halaman" }: { label?: string }) {
  return (
    <main className="page-shell app-page page-loading" aria-busy="true" aria-label={label}>
      <div className="page-loading-heading">
        <Skeleton variant="title" />
        <Skeleton />
      </div>
      <div className="page-loading-grid">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </main>
  );
}
