import { redirect } from "next/navigation";

// Step 6.5d.1 — the two-page login/register split (6.5b, F2) is intentionally superseded by the
// single method-first `/auth/login`. `/auth/register` is now a redirect that preserves every query
// param (notably `oauth` for the brand-new-Google-user role picker, plus `as`, `callbackUrl`, and
// future `invite` for 6.5e). The role declaration moved into the login page's signup sub-flow.
export default async function RegisterRedirectPage(props: {
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
