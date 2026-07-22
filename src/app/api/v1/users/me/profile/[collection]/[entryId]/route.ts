import {
  deleteCollectionEntry,
  updateCollectionEntry,
} from "@/server/user-profile/profile-collection-http";

type Context = { params: Promise<{ collection: string; entryId: string }> };

// PATCH /api/v1/users/me/profile/[collection]/[entryId]
// Replaces one collection entry with a fully-validated payload. Ownership-scoped in the service
// (WHERE id AND user_id) so a foreign id resolves to 404, not another user's data.
export async function PATCH(request: Request, context: Context) {
  const { collection, entryId } = await context.params;
  return updateCollectionEntry(request, collection, entryId);
}

// DELETE /api/v1/users/me/profile/[collection]/[entryId]
export async function DELETE(request: Request, context: Context) {
  const { collection, entryId } = await context.params;
  return deleteCollectionEntry(request, collection, entryId);
}
