import { HostCheckQueue } from "@/components/admin/host-check-queue";
import { HostTrustWatchList } from "@/components/admin/host-trust-watch-list";
import { PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";

export const metadata = {
  title: "Pemeriksaan penyelenggara",
  description: "Periksa kompetisi pertama penyelenggara yang belum tepercaya.",
};

// The queue and the domain watch are read in the browser through their own routes, whose role
// gates guard the data.
export default async function AdminHostChecksPage() {
  await requireRolePage("platform_ops", { callbackPath: "/admin/host-checks" });

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Pemeriksaan penyelenggara"
        description="Periksa kompetisi pertama penyelenggara yang belum tepercaya."
      />
      <HostCheckQueue />
      <HostTrustWatchList />
    </main>
  );
}
