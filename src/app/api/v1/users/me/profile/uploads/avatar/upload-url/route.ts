import { avatarUploadUrl } from "@/server/user-profile/profile-file-http";

// POST /api/v1/users/me/profile/uploads/avatar/upload-url — mint a presigned PUT URL for an avatar.
export const POST = (request: Request) => avatarUploadUrl(request);
