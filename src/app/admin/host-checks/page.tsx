import { HostCheckQueue } from "@/components/admin/host-check-queue";
import { PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";

export const metadata = {
  title: "Pemeriksaan penyelenggara",
  description: "Periksa kompetisi pertama penyelenggara yang belum tepercaya.",
};

// The queue is read in the browser through the queue route, whose own role gate guards the data.
export default async function AdminHostChecksPage() {
  await requireRolePage("platform_ops", { callbackPath: "/admin/host-checks" });

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Pemeriksaan penyelenggara"
        description="Periksa kompetisi pertama penyelenggara yang belum tepercaya."
      />
      <HostCheckQueue />
    </main>
  );
}
