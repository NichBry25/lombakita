import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";

export default async function AdminVerificationPage() {
  await requireRolePage("platform_ops", { callbackPath: "/admin/verification" });

  redirect("/admin/host-checks?tab=centang");
}
