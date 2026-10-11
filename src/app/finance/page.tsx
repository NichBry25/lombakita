import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";

// One surface exists today, so the shell root is its address rather than a hub of one card.
export default async function FinanceHubPage() {
  await requireRolePage("finance_ops", { callbackPath: "/finance" });

  redirect("/finance/payments");
}
