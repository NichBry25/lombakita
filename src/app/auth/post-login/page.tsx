import { redirect } from "next/navigation";

// Legacy landing route kept for compatibility with any old links or bookmarks. The current
// sign-in flow lands at `/` directly and the second-role-prompt modal (mounted globally)
// handles the prompt UX. This page simply forwards to the homepage.
export default function PostLoginPage() {
  redirect("/");
}
