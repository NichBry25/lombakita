import { ModerationConsole } from "./moderation-console";
import { PageHeader } from "@/components/ui";

// Protected by /admin/layout.tsx — platform_ops only. The moderation and support console for platform_ops.
export default async function AdminModerationPage(props: {
  searchParams?: Promise<{ email?: string }>;
}) {
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
