import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentSession } from "@/server/auth/session";

const PAGE_PATH = "/admin/institutions";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(PAGE_PATH)}`);
  }

  if (session.user.role !== "platform_ops") {
    redirect("/");
  }

  return <>{children}</>;
}
