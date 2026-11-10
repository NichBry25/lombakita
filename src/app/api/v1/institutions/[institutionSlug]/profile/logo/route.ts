import {
  institutionMediaDelete,
  institutionMediaRecord,
} from "@/server/institution-workspace/institution-media-http";

type Context = { params: Promise<{ institutionSlug: string }> };

// PUT: record the uploaded key.
// DELETE: remove the logo.
// Owner-only; personal institutions are refused by the service.
export async function PUT(request: Request, context: Context): Promise<Response> {
  const { institutionSlug } = await context.params;
  return institutionMediaRecord(request, institutionSlug, "logo");
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { institutionSlug } = await context.params;
  return institutionMediaDelete(request, institutionSlug, "logo");
}
