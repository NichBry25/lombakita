import { resumeUploadUrl } from "@/server/user-profile/profile-file-http";

// POST /api/v1/users/me/profile/uploads/resume/upload-url — mint a presigned PUT URL for a resume.
export const POST = (request: Request) => resumeUploadUrl(request);
