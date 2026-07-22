import {
  certificationFileDelete,
  certificationFileRecord,
} from "@/server/user-profile/profile-file-http";

type Context = { params: Promise<{ entryId: string }> };

// PUT    /api/v1/users/me/profile/uploads/certifications/[entryId] — record the uploaded file key.
// DELETE /api/v1/users/me/profile/uploads/certifications/[entryId] — remove the attached file.
export async function PUT(request: Request, context: Context) {
  const { entryId } = await context.params;
  return certificationFileRecord(request, entryId);
}

export async function DELETE(request: Request, context: Context) {
  const { entryId } = await context.params;
  return certificationFileDelete(request, entryId);
}
