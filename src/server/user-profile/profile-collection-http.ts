import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import {
  ProfileCollectionError,
  parseCertificationInput,
  parseEducationInput,
  parseExperienceInput,
  parseSkillInput,
  parseSocialLinkInput,
  profileCollectionErrorStatus,
} from "@/server/user-profile/profile-collections-core";
import {
  addCertification,
  addEducation,
  addExperience,
  addSkill,
  addSocialLink,
  deleteCertification,
  deleteEducation,
  deleteExperience,
  deleteSkill,
  deleteSocialLink,
  updateCertification,
  updateEducation,
  updateExperience,
  updateSocialLink,
} from "@/server/user-profile/profile-collections-service";

// Each registry entry hides its collection's concrete Input type behind a uniform
// (userId, payload) shape so the route handlers stay collection-agnostic. `update` is absent for
// skills (a skill has no editable field beyond its unique name — callers delete and re-add).
type CollectionHandlers = {
  create: (userId: string, payload: unknown) => Promise<unknown>;
  update?: (userId: string, id: string, payload: unknown) => Promise<unknown>;
  remove: (userId: string, id: string) => Promise<void>;
};

const REGISTRY: Record<string, CollectionHandlers> = {
  experiences: {
    create: (userId, payload) => addExperience(userId, parseExperienceInput(payload)),
    update: (userId, id, payload) => updateExperience(userId, id, parseExperienceInput(payload)),
    remove: deleteExperience,
  },
  educations: {
    create: (userId, payload) => addEducation(userId, parseEducationInput(payload)),
    update: (userId, id, payload) => updateEducation(userId, id, parseEducationInput(payload)),
    remove: deleteEducation,
  },
  skills: {
    create: (userId, payload) => addSkill(userId, parseSkillInput(payload)),
    remove: deleteSkill,
  },
  certifications: {
    create: (userId, payload) => addCertification(userId, parseCertificationInput(payload)),
    update: (userId, id, payload) =>
      updateCertification(userId, id, parseCertificationInput(payload)),
    remove: deleteCertification,
  },
  "social-links": {
    create: (userId, payload) => addSocialLink(userId, parseSocialLinkInput(payload)),
    update: (userId, id, payload) => updateSocialLink(userId, id, parseSocialLinkInput(payload)),
    remove: deleteSocialLink,
  },
};

export const PROFILE_COLLECTION_SLUGS = Object.keys(REGISTRY);

const unknownCollection = (): NextResponse =>
  NextResponse.json(
    { error: { code: "profile_collection_not_found", message: "Unknown collection" } },
    { status: 404 },
  );

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new ProfileCollectionError(
      "profile_collection_invalid_payload",
      "Request body must be valid JSON",
    );
  }
};

const mapError = (error: unknown): NextResponse => {
  if (error instanceof ProfileCollectionError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details ?? {} } },
      { status: profileCollectionErrorStatus(error.code) },
    );
  }
  return toAccessDeniedResponse(error);
};

// POST /api/v1/users/me/profile/[collection]
export const createCollectionEntry = async (
  request: Request,
  collection: string,
): Promise<Response> => {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const handlers = REGISTRY[collection];
    if (!handlers) return unknownCollection();
    const payload = await readJson(request);
    const entry = await handlers.create(session.user.id, payload);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    return mapError(error);
  }
};

// PATCH /api/v1/users/me/profile/[collection]/[entryId]
export const updateCollectionEntry = async (
  request: Request,
  collection: string,
  entryId: string,
): Promise<Response> => {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const handlers = REGISTRY[collection];
    if (!handlers?.update) return unknownCollection();
    const payload = await readJson(request);
    const entry = await handlers.update(session.user.id, entryId, payload);
    return NextResponse.json({ entry });
  } catch (error) {
    return mapError(error);
  }
};

// DELETE /api/v1/users/me/profile/[collection]/[entryId]
export const deleteCollectionEntry = async (
  request: Request,
  collection: string,
  entryId: string,
): Promise<Response> => {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const handlers = REGISTRY[collection];
    if (!handlers) return unknownCollection();
    await handlers.remove(session.user.id, entryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mapError(error);
  }
};
