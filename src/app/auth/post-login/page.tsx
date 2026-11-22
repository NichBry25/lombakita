import { redirect } from "next/navigation";

// Legacy landing route kept for old links and bookmarks. It forwards to the home page.
export default function PostLoginPage() {
  redirect("/");
}
