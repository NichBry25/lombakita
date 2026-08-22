import { redirect } from "next/navigation";

// One surface exists today, so the shell root is its address rather than a hub of one card.
export default function FinanceHubPage() {
  redirect("/finance/payments");
}
