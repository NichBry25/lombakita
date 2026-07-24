import { redirect } from "next/navigation";

// Retired: recruiter trust verification now lives on the recruiter dashboard's verification panel.
// This route is kept only as a redirect for any legacy bookmark.
export default function VerifyTierPage() {
  redirect("/recruiter-dashboard");
}
