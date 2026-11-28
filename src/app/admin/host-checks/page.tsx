import { HostCheckQueue } from "@/components/admin/host-check-queue";
import { HostTrustWatchList } from "@/components/admin/host-trust-watch-list";
import { TickQueue } from "@/components/admin/tick-queue";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";

const QUEUE_TITLE = "Antrean pemeriksaan";
const QUEUE_DESCRIPTION = "Periksa penyelenggara baru, centang ruang kerja, dan laporan kompetisi.";

export const metadata = {
  title: QUEUE_TITLE,
  description: QUEUE_DESCRIPTION,
};

const TAB_IDS = ["pemeriksaan", "centang", "laporan"] as const;
const DEFAULT_TAB_ID = "pemeriksaan";

const selectedTabIdOf = (tab: string | string[] | undefined): string =>
  TAB_IDS.find((id) => id === tab) ?? DEFAULT_TAB_ID;

// Each queue and the domain watch are read in the browser through their own routes, whose role
// gates guard the data.
export default async function AdminHostChecksPage(props: {
  searchParams?: Promise<{ tab?: string | string[] }>;
}) {
  await requireRolePage("platform_ops", { callbackPath: "/admin/host-checks" });

  const searchParams = await props.searchParams;
  const tabs = [
    {
      id: "pemeriksaan",
      label: "Pemeriksaan penyelenggara",
      panel: (
        <>
          <HostCheckQueue />
          <HostTrustWatchList />
        </>
      ),
    },
    { id: "centang", label: "Centang", panel: <TickQueue /> },
    {
      id: "laporan",
      label: "Laporan",
      panel: (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada laporan"
          description="Belum ada laporan kompetisi."
          size="standard"
        />
      ),
    },
  ];

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader title={QUEUE_TITLE} description={QUEUE_DESCRIPTION} />
      <Tabs
        label={QUEUE_TITLE}
        queryKey="tab"
        selectedId={selectedTabIdOf(searchParams?.tab)}
        tabs={tabs}
      />
    </main>
  );
}
