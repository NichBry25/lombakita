// Client-safe participation-threshold rules. The threshold counts competition entries:
// one individual registration is one entry and one submitted team is one entry, regardless of
// how many members the team contains.

export const INSUFFICIENT_PARTICIPANTS_REASON = "insufficient_participants" as const;

export type CompetitionParticipationState =
  | "not_configured"
  | "collecting_entries"
  | "decision_due"
  | "confirmed"
  | "cancelled";

export type CompetitionParticipationInput = {
  minimumParticipantEntries: number | null;
  participantConfirmationAt: Date | string | null;
  participationConfirmedAt: Date | string | null;
  eventStartAt: Date | string | null;
  cancelledAt: Date | string | null;
  participantEntryCount: number;
};

const toTime = (value: Date | string | null): number | null => {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export const hasMinimumParticipationRule = (
  input: Pick<
    CompetitionParticipationInput,
    "minimumParticipantEntries" | "participantConfirmationAt"
  >,
): boolean =>
  input.minimumParticipantEntries !== null &&
  input.minimumParticipantEntries >= 1 &&
  toTime(input.participantConfirmationAt) !== null;

export const deriveCompetitionParticipationState = (
  input: CompetitionParticipationInput,
  now: Date = new Date(),
): CompetitionParticipationState => {
  if (toTime(input.cancelledAt) !== null) return "cancelled";
  if (!hasMinimumParticipationRule(input)) return "not_configured";
  if (toTime(input.participationConfirmedAt) !== null) return "confirmed";

  const confirmationTime = toTime(input.participantConfirmationAt)!;
  const currentTime = now.getTime();
  if (currentTime < confirmationTime) return "collecting_entries";

  if (input.participantEntryCount >= input.minimumParticipantEntries!) return "confirmed";

  const eventStartTime = toTime(input.eventStartAt);
  if (eventStartTime !== null && currentTime >= eventStartTime) return "confirmed";

  return "decision_due";
};

export const canCancelCompetitionForInsufficientParticipation = (
  input: CompetitionParticipationInput,
  now: Date = new Date(),
): boolean => deriveCompetitionParticipationState(input, now) === "decision_due";

export const canConfirmCompetitionWillProceed = (
  input: CompetitionParticipationInput,
  now: Date = new Date(),
): boolean => deriveCompetitionParticipationState(input, now) === "decision_due";

export const isParticipantCancellationClosedByConfirmation = (
  participantConfirmationAt: Date | string | null,
  now: Date = new Date(),
): boolean => {
  const confirmationTime = toTime(participantConfirmationAt);
  return confirmationTime !== null && now.getTime() >= confirmationTime;
};

const PARTICIPATION_STATE_LABELS: Record<CompetitionParticipationState, string> = {
  not_configured: "Tanpa minimum peserta",
  collecting_entries: "Mengumpulkan peserta",
  decision_due: "Menunggu keputusan",
  confirmed: "Terkonfirmasi",
  cancelled: "Dibatalkan",
};

export const getCompetitionParticipationStateLabel = (
  state: CompetitionParticipationState,
): string => PARTICIPATION_STATE_LABELS[state];

export const getCompetitionCancellationReasonLabel = (reason: string | null): string | null =>
  reason === INSUFFICIENT_PARTICIPANTS_REASON ? "Minimum peserta tidak tercapai." : null;
