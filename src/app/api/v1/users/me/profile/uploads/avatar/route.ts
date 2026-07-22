import { avatarDelete, avatarRecord } from "@/server/user-profile/profile-file-http";

// PUT   /api/v1/users/me/profile/uploads/avatar — record the uploaded avatar key.
// DELETE /api/v1/users/me/profile/uploads/avatar — remove the avatar.
export const PUT = (request: Request) => avatarRecord(request);
export const DELETE = (request: Request) => avatarDelete(request);
