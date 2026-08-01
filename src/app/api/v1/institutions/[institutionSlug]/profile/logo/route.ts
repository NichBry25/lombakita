import {
  institutionMediaDelete,
  institutionMediaRecord,
  institutionMediaUploadUrl,
} from "@/server/institution-workspace/institution-media-http";

type Context = { params: Promise<{ institutionSlug: string }> };

// POST   — presign a direct-to-R2 PUT for the organizer logo. Body: { contentType }.
// PUT    — record the uploaded key. Body: { fileKey }.
// DELETE — remove the logo.
// Owner-only; personal institutions and unconfigured storage are refused by the service.
export async function POST(request: Request, context: Context): Promise<Response> {
  const { institutionSlug } = await context.params;
  return institutionMediaUploadUrl(request, institutionSlug, "logo");
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const { institutionSlug } = await context.params;
  return institutionMediaRecord(request, institutionSlug, "logo");
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { institutionSlug } = await context.params;
  return institutionMediaDelete(request, institutionSlug, "logo");
}
