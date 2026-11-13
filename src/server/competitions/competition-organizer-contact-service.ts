import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-organizer-contact-service");

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions, recruiterVerificationSubmissions, users } from "@/server/db/schema";
import { assertCompetitionAccess } from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import {
  isValidEmailAddress,
  isValidMobileNumber,
} from "@/server/recruiter-verification/recruiter-verification-core";
import {
  ORGANIZER_CONTACT_KINDS,
  toDialDigits,
  toOrganizerContact,
  type OrganizerContact,
  type OrganizerContactKind,
} from "@/lib/competitions/organizer-contact";

export type OrganizerContactSuggestion = { mobileNumber: string | null; email: string };

export type OrganizerContactForEditor = {
  contact: OrganizerContact | null;
  isDraft: boolean;
  suggestion: OrganizerContactSuggestion | null;
};

const isOrganizerContactKind = (value: unknown): value is OrganizerContactKind =>
  typeof value === "string" && (ORGANIZER_CONTACT_KINDS as readonly string[]).includes(value);

const parseEmailContact = (value: string): OrganizerContact => {
  const normalized = value.trim().toLowerCase();
  if (!isValidEmailAddress(normalized)) {
    throw new CompetitionError(
      "competition_organizer_contact_invalid",
      400,
      "value must be a valid email address",
    );
  }
  // The address becomes a mailto link, so ? & = and the like would add hidden recipients or text.
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) {
    throw new CompetitionError(
      "competition_organizer_contact_invalid",
      400,
      "value must be a valid email address",
    );
  }
  return { kind: "email", value: normalized };
};

const parsePhoneContact = (kind: "whatsapp" | "phone", value: string): OrganizerContact => {
  const trimmed = value.trim();
  if (!isValidMobileNumber(trimmed)) {
    throw new CompetitionError(
      "competition_organizer_contact_invalid",
      400,
      "value must be a valid phone number",
    );
  }
  const digits = toDialDigits(trimmed);
  if (digits === null) {
    throw new CompetitionError(
      "competition_organizer_contact_invalid",
      400,
      "value must be an Indonesian number or a number with a + country code",
    );
  }
  if (digits.length < 8 || digits.length > 15) {
    throw new CompetitionError(
      "competition_organizer_contact_invalid",
      400,
      "value must have 8 to 15 digits",
    );
  }
  // WhatsApp needs a mobile number: an Indonesian mobile number is 628 followed by 8 to 11 digits.
  if (kind === "whatsapp" && !/^628\d{8,11}$/.test(digits)) {
    throw new CompetitionError(
      "competition_organizer_contact_not_indonesian",
      400,
      "A WhatsApp contact must be an Indonesian mobile number",
    );
  }
  return { kind, value: digits };
};

// A saved contact can be changed but never cleared, so an empty value is refused, never stored.
export const parseOrganizerContactInput = (payload: unknown): OrganizerContact => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }
  const { kind, value } = payload as { kind?: unknown; value?: unknown };
  if (!isOrganizerContactKind(kind)) {
    throw new CompetitionError(
      "competition_organizer_contact_invalid",
      400,
      "kind must be whatsapp, phone or email",
    );
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CompetitionError("competition_organizer_contact_invalid", 400, "value is required");
  }
  if (kind === "email") return parseEmailContact(value);
  return parsePhoneContact(kind, value);
};

export const loadOrganizerContactSuggestion = async (
  userId: string,
  db: Database,
): Promise<OrganizerContactSuggestion> => {
  const [signup] = await db
    .select({ mobileNumber: recruiterVerificationSubmissions.mobileNumber })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        eq(recruiterVerificationSubmissions.status, "approved"),
      ),
    )
    .orderBy(desc(recruiterVerificationSubmissions.submittedAt))
    .limit(1);
  const [account] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { mobileNumber: signup?.mobileNumber ?? null, email: account!.email };
};

export const getCompetitionOrganizerContactForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<OrganizerContactForEditor> => {
  const { competition, membershipRole } = await assertCompetitionAccess(
    actorUserId,
    competitionId,
    "member",
    db,
  );
  const [row] = await db
    .select({
      kind: competitions.organizerContactKind,
      value: competitions.organizerContactValue,
    })
    .from(competitions)
    .where(eq(competitions.id, competition.id));
  const isDraft = competition.status === "draft";
  // Only an owner can publish, so only an owner's own details fill a draft's contact.
  const suggestion =
    isDraft && membershipRole === "institution_owner"
      ? await loadOrganizerContactSuggestion(actorUserId, db)
      : null;
  return {
    contact: toOrganizerContact(row?.kind ?? null, row?.value ?? null),
    isDraft,
    suggestion,
  };
};

// The only editor write of the contact, so a live competition's contact never passes the
// post-publish classifier and never sends competition.edited.
export const setCompetitionOrganizerContactForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<OrganizerContact> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const contact = parseOrganizerContactInput(payload);
  await db
    .update(competitions)
    .set({
      organizerContactKind: contact.kind,
      organizerContactValue: contact.value,
      updatedAt: sql`now()`,
    })
    .where(eq(competitions.id, competition.id));
  return contact;
};
