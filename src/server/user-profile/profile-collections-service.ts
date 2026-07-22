import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  profileCertifications,
  profileEducations,
  profileExperiences,
  profileSkills,
  profileSocialLinks,
} from "@/server/db/schema";
import { resolveProfileFileUrl } from "@/server/user-profile/profile-files-service";
import {
  MAX_ENTRIES_PER_COLLECTION,
  ProfileCollectionError,
  emptyProfileCollections,
  toDateString,
  type CertificationEntry,
  type CertificationInput,
  type EducationEntry,
  type EducationInput,
  type ExperienceEntry,
  type ExperienceInput,
  type ProfileCollections,
  type SkillEntry,
  type SkillInput,
  type SocialLinkEntry,
  type SocialLinkInput,
} from "@/server/user-profile/profile-collections-core";

// Returns true when the error is a Postgres unique-violation (optionally for a specific
// constraint). Mirrors the constraint-classification idiom in competition-service.ts.
const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  const e = error as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== "23505") return false;
  if (!constraint) return true;
  return e.constraint === constraint || e.constraint_name === constraint;
};

// An INSERT ... RETURNING always yields exactly one row; this narrows away the undefined that
// strict array indexing infers from the destructured result.
const requireInserted = <T>(row: T | undefined): T => {
  if (row === undefined) {
    throw new Error("insert returned no row");
  }
  return row;
};

// ---------------------------------------------------------------------------
// Row → entry mappers
// ---------------------------------------------------------------------------

const toExperienceEntry = (row: typeof profileExperiences.$inferSelect): ExperienceEntry => ({
  id: row.id,
  title: row.title,
  organizationName: row.organizationName,
  location: row.location,
  startDate: toDateString(row.startDate),
  endDate: toDateString(row.endDate),
  isCurrent: row.isCurrent,
  description: row.description,
});

const toEducationEntry = (row: typeof profileEducations.$inferSelect): EducationEntry => ({
  id: row.id,
  school: row.school,
  degree: row.degree,
  fieldOfStudy: row.fieldOfStudy,
  startYear: row.startYear,
  endYear: row.endYear,
  description: row.description,
});

const toSkillEntry = (row: typeof profileSkills.$inferSelect): SkillEntry => ({
  id: row.id,
  name: row.name,
});

const toCertificationEntry = (
  row: typeof profileCertifications.$inferSelect,
): CertificationEntry => ({
  id: row.id,
  name: row.name,
  issuer: row.issuer,
  issueDate: toDateString(row.issueDate),
  expiryDate: toDateString(row.expiryDate),
  credentialId: row.credentialId,
  credentialUrl: row.credentialUrl,
  fileName: row.fileName,
  // Populated by the full-read enrichment in getProfileCollections; null on add/update returns.
  fileUrl: null,
});

const toSocialLinkEntry = (row: typeof profileSocialLinks.$inferSelect): SocialLinkEntry => ({
  id: row.id,
  platform: row.platform,
  url: row.url,
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Reads all detail collections for one user, each ordered for display. Used by both the owner
// and public profile responses (role-agnostic — the two see the same collection data).
export const getProfileCollections = async (
  userId: string,
  db: Database = getDb(),
): Promise<ProfileCollections> => {
  const [experiences, educations, skills, certifications, socialLinks] = await Promise.all([
    db
      .select()
      .from(profileExperiences)
      .where(eq(profileExperiences.userId, userId))
      .orderBy(
        desc(profileExperiences.isCurrent),
        sql`${profileExperiences.startDate} DESC NULLS LAST`,
        desc(profileExperiences.createdAt),
      ),
    db
      .select()
      .from(profileEducations)
      .where(eq(profileEducations.userId, userId))
      .orderBy(
        sql`${profileEducations.endYear} DESC NULLS FIRST`,
        sql`${profileEducations.startYear} DESC NULLS LAST`,
        desc(profileEducations.createdAt),
      ),
    db
      .select()
      .from(profileSkills)
      .where(eq(profileSkills.userId, userId))
      .orderBy(asc(sql`lower(${profileSkills.name})`)),
    db
      .select()
      .from(profileCertifications)
      .where(eq(profileCertifications.userId, userId))
      .orderBy(
        sql`${profileCertifications.issueDate} DESC NULLS LAST`,
        desc(profileCertifications.createdAt),
      ),
    db
      .select()
      .from(profileSocialLinks)
      .where(eq(profileSocialLinks.userId, userId))
      .orderBy(asc(profileSocialLinks.platform)),
  ]);

  // Certifications carry an optional uploaded file; presign a short-lived GET URL for each on the
  // full read (null when there is no file or R2 is unavailable).
  const certificationEntries = await Promise.all(
    certifications.map(async (row) => ({
      ...toCertificationEntry(row),
      fileUrl: await resolveProfileFileUrl(row.fileR2Key),
    })),
  );

  return {
    experiences: experiences.map(toExperienceEntry),
    educations: educations.map(toEducationEntry),
    skills: skills.map(toSkillEntry),
    certifications: certificationEntries,
    socialLinks: socialLinks.map(toSocialLinkEntry),
  };
};

export { emptyProfileCollections };

// ---------------------------------------------------------------------------
// Create — rejects when the per-collection cap is reached
// ---------------------------------------------------------------------------

type ProfileCollectionTable =
  | typeof profileExperiences
  | typeof profileEducations
  | typeof profileSkills
  | typeof profileCertifications
  | typeof profileSocialLinks;

const countFor = async (
  db: Database,
  table: ProfileCollectionTable,
  userId: string,
): Promise<number> => {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.userId, userId));
  return row?.value ?? 0;
};

const assertUnderLimit = (current: number): void => {
  if (current >= MAX_ENTRIES_PER_COLLECTION) {
    throw new ProfileCollectionError(
      "profile_collection_limit_reached",
      `You can add at most ${MAX_ENTRIES_PER_COLLECTION} entries to this section`,
    );
  }
};

export const addExperience = async (
  userId: string,
  input: ExperienceInput,
  db: Database = getDb(),
): Promise<ExperienceEntry> => {
  assertUnderLimit(await countFor(db, profileExperiences, userId));
  const [row] = await db
    .insert(profileExperiences)
    .values({ userId, ...input })
    .returning();
  return toExperienceEntry(requireInserted(row));
};

export const addEducation = async (
  userId: string,
  input: EducationInput,
  db: Database = getDb(),
): Promise<EducationEntry> => {
  assertUnderLimit(await countFor(db, profileEducations, userId));
  const [row] = await db
    .insert(profileEducations)
    .values({ userId, ...input })
    .returning();
  return toEducationEntry(requireInserted(row));
};

export const addSkill = async (
  userId: string,
  input: SkillInput,
  db: Database = getDb(),
): Promise<SkillEntry> => {
  assertUnderLimit(await countFor(db, profileSkills, userId));
  try {
    const [row] = await db
      .insert(profileSkills)
      .values({ userId, ...input })
      .returning();
    return toSkillEntry(requireInserted(row));
  } catch (error) {
    if (isUniqueViolation(error, "profile_skills_user_name_unique_idx")) {
      throw new ProfileCollectionError(
        "profile_collection_duplicate",
        "You already added this skill",
        { fields: ["name"] },
      );
    }
    throw error;
  }
};

export const addCertification = async (
  userId: string,
  input: CertificationInput,
  db: Database = getDb(),
): Promise<CertificationEntry> => {
  assertUnderLimit(await countFor(db, profileCertifications, userId));
  const [row] = await db
    .insert(profileCertifications)
    .values({ userId, ...input })
    .returning();
  return toCertificationEntry(requireInserted(row));
};

export const addSocialLink = async (
  userId: string,
  input: SocialLinkInput,
  db: Database = getDb(),
): Promise<SocialLinkEntry> => {
  try {
    const [row] = await db
      .insert(profileSocialLinks)
      .values({ userId, ...input })
      .returning();
    return toSocialLinkEntry(requireInserted(row));
  } catch (error) {
    if (isUniqueViolation(error, "profile_social_links_user_platform_unique_idx")) {
      throw new ProfileCollectionError(
        "profile_collection_duplicate",
        "You already added a link for this platform",
        { fields: ["platform"] },
      );
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Update — ownership-scoped (WHERE id AND user_id); missing row → not_found
// ---------------------------------------------------------------------------

const notFound = (): never => {
  throw new ProfileCollectionError("profile_collection_not_found", "Entry not found");
};

export const updateExperience = async (
  userId: string,
  id: string,
  input: ExperienceInput,
  db: Database = getDb(),
): Promise<ExperienceEntry> => {
  const [row] = await db
    .update(profileExperiences)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(profileExperiences.id, id), eq(profileExperiences.userId, userId)))
    .returning();
  if (!row) return notFound();
  return toExperienceEntry(row);
};

export const updateEducation = async (
  userId: string,
  id: string,
  input: EducationInput,
  db: Database = getDb(),
): Promise<EducationEntry> => {
  const [row] = await db
    .update(profileEducations)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(profileEducations.id, id), eq(profileEducations.userId, userId)))
    .returning();
  if (!row) return notFound();
  return toEducationEntry(row);
};

export const updateCertification = async (
  userId: string,
  id: string,
  input: CertificationInput,
  db: Database = getDb(),
): Promise<CertificationEntry> => {
  const [row] = await db
    .update(profileCertifications)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(profileCertifications.id, id), eq(profileCertifications.userId, userId)))
    .returning();
  if (!row) return notFound();
  return toCertificationEntry(row);
};

export const updateSocialLink = async (
  userId: string,
  id: string,
  input: SocialLinkInput,
  db: Database = getDb(),
): Promise<SocialLinkEntry> => {
  try {
    const [row] = await db
      .update(profileSocialLinks)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(profileSocialLinks.id, id), eq(profileSocialLinks.userId, userId)))
      .returning();
    if (!row) return notFound();
    return toSocialLinkEntry(row);
  } catch (error) {
    if (isUniqueViolation(error, "profile_social_links_user_platform_unique_idx")) {
      throw new ProfileCollectionError(
        "profile_collection_duplicate",
        "You already added a link for this platform",
        { fields: ["platform"] },
      );
    }
    throw error;
  }
};

// Skills have no editable fields beyond the unique name, so there is no update — callers delete
// and re-add. Deletes below are ownership-scoped and idempotent-safe (missing row → not_found).

// ---------------------------------------------------------------------------
// Delete — ownership-scoped
// ---------------------------------------------------------------------------

const deleteScoped = async (
  db: Database,
  table:
    | typeof profileExperiences
    | typeof profileEducations
    | typeof profileSkills
    | typeof profileCertifications
    | typeof profileSocialLinks,
  userId: string,
  id: string,
): Promise<void> => {
  const deleted = await db
    .delete(table)
    .where(and(eq(table.id, id), eq(table.userId, userId)))
    .returning({ id: table.id });
  if (deleted.length === 0) notFound();
};

export const deleteExperience = (userId: string, id: string, db: Database = getDb()) =>
  deleteScoped(db, profileExperiences, userId, id);

export const deleteEducation = (userId: string, id: string, db: Database = getDb()) =>
  deleteScoped(db, profileEducations, userId, id);

export const deleteSkill = (userId: string, id: string, db: Database = getDb()) =>
  deleteScoped(db, profileSkills, userId, id);

export const deleteCertification = (userId: string, id: string, db: Database = getDb()) =>
  deleteScoped(db, profileCertifications, userId, id);

export const deleteSocialLink = (userId: string, id: string, db: Database = getDb()) =>
  deleteScoped(db, profileSocialLinks, userId, id);
