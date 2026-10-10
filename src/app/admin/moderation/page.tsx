import { ModerationConsole } from "./moderation-console";
import { PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";

export default async function AdminModerationPage(props: {
  searchParams?: Promise<{ email?: string }>;
}) {
  await requireRolePage("platform_ops", { callbackPath: "/admin/moderation" });

  const searchParams = await props.searchParams;
  return (
    <main className="page-shell app-page admin-page admin-moderation-page">
      <PageHeader
        title="Moderasi & dukungan"
        description="Cari pengguna atau institusi untuk menangguhkan, memulihkan, dan menambah catatan internal."
      />
      <ModerationConsole initialEmail={searchParams?.email} />
    </main>
  );
}
