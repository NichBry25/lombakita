import { certificationFileUploadUrl } from "@/server/user-profile/profile-file-http";

// POST /api/v1/users/me/profile/uploads/certifications/[entryId]/upload-url
// Mint a presigned PUT URL for a file attached to one of the caller's certifications.
export async function POST(request: Request, context: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await context.params;
  return certificationFileUploadUrl(request, entryId);
}
