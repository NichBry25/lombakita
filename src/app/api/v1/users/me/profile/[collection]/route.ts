import { createCollectionEntry } from "@/server/user-profile/profile-collection-http";

// POST /api/v1/users/me/profile/[collection]
// Creates one entry in a role-agnostic profile detail collection (experiences | educations |
// skills | certifications | social-links). Auth-gated; acts on the caller's own data, so the
// cross-session guard (Rule #16) runs inside the shared handler.
export async function POST(request: Request, context: { params: Promise<{ collection: string }> }) {
  const { collection } = await context.params;
  return createCollectionEntry(request, collection);
}
