import { bannerDelete, bannerRecord } from "@/server/user-profile/profile-file-http";

// PUT    /api/v1/users/me/profile/uploads/banner — record the uploaded banner key.
// DELETE /api/v1/users/me/profile/uploads/banner — remove the banner.
export const PUT = (request: Request) => bannerRecord(request);
export const DELETE = (request: Request) => bannerDelete(request);
