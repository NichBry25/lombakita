import { bannerUploadUrl } from "@/server/user-profile/profile-file-http";

// POST /api/v1/users/me/profile/uploads/banner/upload-url — mint a presigned PUT URL for a banner.
export const POST = (request: Request) => bannerUploadUrl(request);
