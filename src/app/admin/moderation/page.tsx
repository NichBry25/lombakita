import { ModerationConsole } from "./moderation-console";
import { PageHeader } from "@/components/ui";

// Protected by /admin/layout.tsx — platform_ops only. Minimal proof moderation console.
export default function AdminModerationPage() {
  return (
    <main className="page-shell app-page admin-page admin-moderation-page">
      <PageHeader
        eyebrow="Keamanan dan dukungan"
        title="Moderasi & dukungan"
        description="Cari pengguna atau institusi untuk menangguhkan, memulihkan, dan menambah catatan internal."
        backHref="/admin"
        backLabel="Panel Platform Ops"
      />
      <ModerationConsole />
    </main>
  );
}
