import { redirect } from "next/navigation";

// F2 (Step 6.5b): /auth/signup redirects to /auth/register, preserving the ?as= param.
export default async function SignupRedirectPage(props: {
  searchParams?: Promise<{ as?: string }>;
}) {
  const searchParams = await props.searchParams;
  const asParam = searchParams?.as;
  redirect(asParam ? `/auth/register?as=${encodeURIComponent(asParam)}` : "/auth/register");
}
