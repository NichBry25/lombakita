import { redirect } from "next/navigation";

// /auth/sign-in is the legacy login entry — redirect to /auth/login.
// Preserves any callbackUrl, error, verified, and email query params.
export default async function SignInRedirectPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams ?? {})) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val !== undefined) params.set(k, val);
  }
  const qs = params.toString();
  redirect(`/auth/login${qs ? `?${qs}` : ""}`);
}
