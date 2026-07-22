import {
  resumeDelete,
  resumeRecord,
  resumeSetVisibility,
} from "@/server/user-profile/profile-file-http";

// PUT    /api/v1/users/me/profile/uploads/resume — record the uploaded resume key + metadata.
// PATCH  /api/v1/users/me/profile/uploads/resume — set resume visibility ({ isPublic: boolean }).
// DELETE /api/v1/users/me/profile/uploads/resume — remove the resume.
export const PUT = (request: Request) => resumeRecord(request);
export const PATCH = (request: Request) => resumeSetVisibility(request);
export const DELETE = (request: Request) => resumeDelete(request);
