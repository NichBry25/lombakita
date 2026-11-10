import { institutionMediaUploadUrl } from "@/server/institution-workspace/institution-media-http";

type Context = { params: Promise<{ institutionSlug: string }> };

// POST: presign a direct-to-R2 PUT for the institution banner. Owner-only; personal
// institutions and unconfigured storage are refused by the service.
export async function POST(request: Request, context: Context): Promise<Response> {
  const { institutionSlug } = await context.params;
  return institutionMediaUploadUrl(request, institutionSlug, "banner");
}
