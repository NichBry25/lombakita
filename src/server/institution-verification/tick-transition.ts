import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database } from "@/server/db/client";
import {
  institutionTickPathEnum,
  institutionVerificationAudit,
  institutions,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import { assertValidTransition, VerificationError } from "./verification-core";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-verification/tick-transition");

export type TickPath = (typeof institutionTickPathEnum.enumValues)[number];

// What happens to name_checked_at, name_proof_due_at and name_proof_reminded_at in one write:
// keep leaves a running proof and its reminder alone and clears the check, cleared nulls all
// three, checked records a name check and ends any proof, proofStarted opens a 28 day proof.
export type TickNameState = "keep" | "cleared" | "checked" | "proofStarted";

export const TICK_REMOVED_WEBSITE = "Situs web diubah.";
export const TICK_REMOVED_RENAME = "Nama ruang kerja diubah.";
export const TICK_REMOVED_WEBSITE_DURING_PROOF = "Situs web diubah selama bukti nama berjalan.";
export const TICK_REMOVED_RENAME_DURING_PROOF =
  "Nama ruang kerja diubah selama bukti nama berjalan.";
export const TICK_REMOVED_NAME_PROOF = "Bukti nama tidak dikirim dalam 28 hari.";

type InstitutionRow = typeof institutions.$inferSelect;
type VerificationAuditRow = typeof institutionVerificationAudit.$inferSelect;
type InstitutionColumnUpdates = PgUpdateSetSource<typeof institutions>;

export type TickTransitionResult = {
  institution: InstitutionRow;
  auditEntry: VerificationAuditRow;
};

export type WriteTickTransitionInput = {
  institutionId: string;
  from: InstitutionVerificationStatus;
  to: InstitutionVerificationStatus;
  tickPath: TickPath | null;
  tickDomain: string | null;
  nameState: TickNameState;
  actorUserId: string | null;
  reason: string | null;
  extraWhere?: SQL;
};

export type RemoveTickAutomaticallyInput = {
  institutionId: string;
  actorUserId: string | null;
  reason: string;
  extraWhere?: SQL;
};

const nameColumnsFor = (nameState: TickNameState): InstitutionColumnUpdates => {
  switch (nameState) {
    case "keep":
      return { nameCheckedAt: null };
    case "cleared":
      return { nameCheckedAt: null, nameProofDueAt: null, nameProofRemindedAt: null };
    case "checked":
      return { nameCheckedAt: sql`now()`, nameProofDueAt: null, nameProofRemindedAt: null };
    case "proofStarted":
      return {
        nameCheckedAt: null,
        nameProofDueAt: sql`now() + interval '28 days'`,
        nameProofRemindedAt: null,
      };
  }
};

const statusColumnsFor = (input: WriteTickTransitionInput): InstitutionColumnUpdates => {
  if (input.to === "verified" && input.from !== "verified") {
    return { verifiedAt: new Date(), updatedAt: sql`now()` };
  }
  if (input.to === "rejected") {
    return { rejectedAt: new Date(), rejectionReason: input.reason, updatedAt: sql`now()` };
  }
  return { updatedAt: sql`now()` };
};

const throwTransitionConflict = (): never => {
  throw new VerificationError(
    "verification_transition_conflict",
    409,
    "This institution's verification status changed while you were deciding. Reload and try again",
  );
};

// created_at is clock_timestamp() so two rows written in one transaction still order by the time
// they were written, which the closure reads depend on.
const insertAuditRow = async (
  tx: Database,
  row: Pick<
    VerificationAuditRow,
    "institutionId" | "actorUserId" | "fromStatus" | "toStatus" | "reason"
  >,
): Promise<VerificationAuditRow> => {
  const [auditEntry] = await tx
    .insert(institutionVerificationAudit)
    .values({ ...row, createdAt: sql`clock_timestamp()` })
    .returning();
  if (!auditEntry) {
    throw new Error("Failed to insert verification audit entry");
  }
  return auditEntry;
};

// The one writer of tick_path, tick_domain, name_checked_at, name_proof_due_at and
// name_proof_reminded_at for a grant, a path move or a staff removal. A path move (verified to
// verified) skips assertValidTransition and its caller pins tick_path in extraWhere.
export const writeTickTransition = async (
  tx: Database,
  input: WriteTickTransitionInput,
): Promise<TickTransitionResult> => {
  const isPathMove = input.from === "verified" && input.to === "verified";
  if (!isPathMove) assertValidTransition(input.from, input.to);

  const isTick = input.to === "verified";
  const [institution] = await tx
    .update(institutions)
    .set({
      verificationStatus: input.to,
      tickPath: isTick ? input.tickPath : null,
      tickDomain: isTick ? input.tickDomain : null,
      ...nameColumnsFor(input.nameState),
      ...statusColumnsFor(input),
    })
    .where(
      and(
        eq(institutions.id, input.institutionId),
        eq(institutions.verificationStatus, input.from),
        input.extraWhere,
      ),
    )
    .returning();
  if (!institution) return throwTransitionConflict();

  const auditEntry = await insertAuditRow(tx, {
    institutionId: input.institutionId,
    actorUserId: input.actorUserId,
    fromStatus: input.from,
    toStatus: input.to,
    reason: input.reason,
  });
  return { institution, auditEntry };
};

// The automatic removal of a tick: verified to pending_verification with all five tick columns
// null. ALLOWED_TRANSITIONS does not hold this move, so no staff request can ask for it.
export const removeTickAutomatically = async (
  tx: Database,
  input: RemoveTickAutomaticallyInput,
): Promise<TickTransitionResult> => {
  const [institution] = await tx
    .update(institutions)
    .set({
      verificationStatus: "pending_verification",
      tickPath: null,
      tickDomain: null,
      nameCheckedAt: null,
      nameProofDueAt: null,
      nameProofRemindedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(institutions.id, input.institutionId),
        eq(institutions.verificationStatus, "verified"),
        input.extraWhere,
      ),
    )
    .returning();
  if (!institution) return throwTransitionConflict();

  const auditEntry = await insertAuditRow(tx, {
    institutionId: input.institutionId,
    actorUserId: input.actorUserId,
    fromStatus: "verified",
    toStatus: "pending_verification",
    reason: input.reason,
  });
  return { institution, auditEntry };
};
