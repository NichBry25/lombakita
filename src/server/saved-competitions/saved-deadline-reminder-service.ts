import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/saved-competitions/saved-deadline-reminder-service");

import { and, asc, eq, gt, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  competitionSaves,
  institutions,
  teamMemberships,
  users,
} from "@/server/db/schema";
import { buildPublicVisibilityCondition } from "@/server/competitions/competition-public-service";

// Reminders for saved competitions whose registration is about to close.
//
// Saving a competition is a student saying "I mean to come back to this". Without a reminder the
// only way back is remembering, and a deadline passes whether or not anyone remembers it. This is
// the one place the platform keeps that promise for them.
//
// STATELESS BY DESIGN. Nothing records that a reminder went out. The sweep runs once a day at a
// fixed moment (the anchor), and a deadline is due a reminder only when it falls inside the
// one-day band that ends exactly N days after the anchor. Consecutive anchors are exactly one day
// apart, so each deadline lands in each band on one day only: every reminder goes out once, with
// no table to write, migrate or clean up. The cost is that a day the worker is down skips that
// day's reminders rather than sending them late, which is the right failure for a nudge: the next
// band still fires, and a late "3 days left" would be wrong by the time it arrived.

const DAY_MS = 24 * 60 * 60 * 1000;

// A week out to plan, three days out to finish, and the final day.
export const REMINDER_DAYS_BEFORE = [7, 3, 1] as const;

// The sweep's moment: 09:00 WIB, which is 02:00 UTC. Morning, so the email is read the day it is
// sent, and still morning in WITA and WIT.
const ANCHOR_UTC_HOUR = 2;

// The most recent 09:00 WIB at or before `now`. A run that starts a few minutes late (a busy queue,
// a slow boot) still reminds about the bands of the day it was scheduled for.
export const resolveReminderAnchor = (now: Date): Date => {
  const anchor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), ANCHOR_UTC_HOUR),
  );
  if (anchor.getTime() > now.getTime()) anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor;
};

// Which reminder a deadline is due at this anchor: the N in "N days before", or null when it falls
// in no band. A deadline exactly N days after the anchor counts as N, so a competition closing at
// 09:00 gets its last-day reminder that same morning rather than a day early.
export const reminderDaysBefore = (deadline: Date, anchor: Date): number | null => {
  const remainingMs = deadline.getTime() - anchor.getTime();
  if (remainingMs <= 0) return null;
  const daysLeft = Math.ceil(remainingMs / DAY_MS);
  return (REMINDER_DAYS_BEFORE as readonly number[]).includes(daysLeft) ? daysLeft : null;
};

const daysAfter = (anchor: Date, days: number) => new Date(anchor.getTime() + days * DAY_MS);

export type DueSavedDeadlineReminder = {
  userId: string;
  competitionId: string;
  competitionSlug: string;
  competitionTitle: string;
  institutionSlug: string;
  registrationEndAt: Date;
  daysBefore: number;
};

// Every saved competition due a reminder at `anchor`, soonest deadline first, optionally for one
// student. Due means all of:
// - publicly visible (the same rule as the listing), not cancelled, and registration already open,
//   since "3 days left" for a form that has not opened yet would send the student to a closed door;
// - the deadline falls in one of the reminder bands;
// - the student's account is active and not suspended;
// - the student has not registered, either on their own or through a team they belong to. A
//   reminder to register for something already registered for is noise, and noise is what gets
//   reminders turned off.
export const listDueSavedDeadlineReminders = async (
  anchor: Date,
  options: { userId?: string } = {},
  db: Database = getDb(),
): Promise<DueSavedDeadlineReminder[]> => {
  const bands = REMINDER_DAYS_BEFORE.map(
    (days) =>
      and(
        gt(competitions.registrationEndAt, daysAfter(anchor, days - 1)),
        lte(competitions.registrationEndAt, daysAfter(anchor, days)),
      )!,
  );

  const registeredAlone = db
    .select({ one: sql`1` })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitions.id),
        eq(competitionRegistrations.studentId, competitionSaves.userId),
        ne(competitionRegistrations.status, "cancelled"),
      ),
    );

  const registeredWithTeam = db
    .select({ one: sql`1` })
    .from(competitionRegistrations)
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, competitionRegistrations.teamId))
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitions.id),
        eq(teamMemberships.userId, competitionSaves.userId),
        eq(teamMemberships.status, "active"),
        ne(competitionRegistrations.status, "cancelled"),
      ),
    );

  const rows = await db
    .select({
      userId: competitionSaves.userId,
      competitionId: competitions.id,
      competitionSlug: competitions.slug,
      competitionTitle: competitions.title,
      institutionSlug: institutions.slug,
      registrationEndAt: competitions.registrationEndAt,
    })
    .from(competitionSaves)
    .innerJoin(competitions, eq(competitions.id, competitionSaves.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(users, eq(users.id, competitionSaves.userId))
    .where(
      and(
        buildPublicVisibilityCondition(),
        isNull(competitions.cancelledAt),
        or(isNull(competitions.registrationStartAt), lte(competitions.registrationStartAt, anchor)),
        or(...bands),
        eq(users.status, "active"),
        isNull(users.suspendedAt),
        options.userId ? eq(competitionSaves.userId, options.userId) : undefined,
        notExists(registeredAlone),
        notExists(registeredWithTeam),
      ),
    )
    .orderBy(asc(competitions.registrationEndAt));

  return rows.flatMap((row) => {
    // The bands in the query already guarantee both; this narrows the type and keeps the query and
    // the band arithmetic from ever disagreeing silently.
    if (!row.registrationEndAt) return [];
    const daysBefore = reminderDaysBefore(row.registrationEndAt, anchor);
    if (daysBefore === null) return [];
    return [{ ...row, registrationEndAt: row.registrationEndAt, daysBefore }];
  });
};

// The address to remind, or null when the account is gone or no longer active. Read at send time,
// not sweep time, so an account deactivated in between is not written to.
export const findReminderRecipientEmail = async (
  userId: string,
  db: Database = getDb(),
): Promise<string | null> => {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active"), isNull(users.suspendedAt)))
    .limit(1);
  return row?.email ?? null;
};

export type SavedDeadlineReminderSweepResult = {
  anchorAt: Date;
  due: number;
  students: number;
  enqueued: number;
  failed: number;
};

// Finds today's due reminders and hands each student one job. Grouping by student is what keeps
// this to one email a day however many saved competitions are closing.
//
// A failure to enqueue one student is logged and counted, never thrown: rethrowing would ask
// BullMQ to retry the whole sweep and re-enqueue every student who already succeeded. Their job ids
// are deterministic, so that would be harmless, but it would also be pointless.
export const sweepSavedDeadlineReminders = async (options: {
  enqueue: (input: { userId: string; anchorAt: string }) => Promise<unknown>;
  now?: Date;
  db?: Database;
}): Promise<SavedDeadlineReminderSweepResult> => {
  const anchor = resolveReminderAnchor(options.now ?? new Date());
  const due = await listDueSavedDeadlineReminders(anchor, {}, options.db ?? getDb());
  const studentIds = [...new Set(due.map((reminder) => reminder.userId))];

  let enqueued = 0;
  let failed = 0;

  for (const userId of studentIds) {
    try {
      await options.enqueue({ userId, anchorAt: anchor.toISOString() });
      enqueued += 1;
    } catch (error) {
      failed += 1;
      logger.warn("saved.deadline_reminder.enqueue_failed", {
        userId,
        anchorAt: anchor.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { anchorAt: anchor, due: due.length, students: studentIds.length, enqueued, failed };
};
