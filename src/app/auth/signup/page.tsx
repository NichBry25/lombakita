import { redirect } from "next/navigation";

// Step 6.5d.1 — legacy signup entry. Redirects to the single method-first `/auth/login`
// (previously redirected to /auth/register, which itself now redirects here). Preserves any
// query params for continuity.
export default async function SignupRedirectPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined) {
      params.set(key, single);
    }
  }
  const qs = params.toString();
  redirect(`/auth/login${qs ? `?${qs}` : ""}`);
}
