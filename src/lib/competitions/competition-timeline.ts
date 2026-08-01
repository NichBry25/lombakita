export type CompetitionTimelineField =
  | "registrationStartAt"
  | "registrationEndAt"
  | "participantConfirmationAt"
  | "eventStartAt"
  | "eventEndAt"
  | "resultAnnouncementAt";

export type CompetitionTimelineInput = Record<
  CompetitionTimelineField,
  Date | string | null | undefined
>;

export type CompetitionTimelineError = {
  field: CompetitionTimelineField;
  relatedField: CompetitionTimelineField;
  message: string;
};

const toTimestamp = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
};

export const validateCompetitionTimeline = (
  timeline: CompetitionTimelineInput,
): CompetitionTimelineError[] => {
  const registrationStart = toTimestamp(timeline.registrationStartAt);
  const registrationEnd = toTimestamp(timeline.registrationEndAt);
  const participantConfirmation = toTimestamp(timeline.participantConfirmationAt);
  const eventStart = toTimestamp(timeline.eventStartAt);
  const eventEnd = toTimestamp(timeline.eventEndAt);
  const resultAnnouncement = toTimestamp(timeline.resultAnnouncementAt);
  const errors: CompetitionTimelineError[] = [];

  if (
    registrationStart !== null &&
    registrationEnd !== null &&
    registrationEnd <= registrationStart
  ) {
    errors.push({
      field: "registrationEndAt",
      relatedField: "registrationStartAt",
      message: "Pendaftaran berakhir harus setelah pendaftaran mulai.",
    });
  }
  if (
    registrationEnd !== null &&
    participantConfirmation !== null &&
    participantConfirmation < registrationEnd
  ) {
    errors.push({
      field: "participantConfirmationAt",
      relatedField: "registrationEndAt",
      message: "Konfirmasi peserta harus pada atau setelah pendaftaran berakhir.",
    });
  }
  if (registrationEnd !== null && eventStart !== null && eventStart < registrationEnd) {
    errors.push({
      field: "eventStartAt",
      relatedField: "registrationEndAt",
      message: "Acara mulai harus pada atau setelah pendaftaran berakhir.",
    });
  }
  if (
    participantConfirmation !== null &&
    eventStart !== null &&
    eventStart <= participantConfirmation
  ) {
    errors.push({
      field: "eventStartAt",
      relatedField: "participantConfirmationAt",
      message: "Acara mulai harus setelah konfirmasi peserta.",
    });
  }
  if (eventStart !== null && eventEnd !== null && eventEnd <= eventStart) {
    errors.push({
      field: "eventEndAt",
      relatedField: "eventStartAt",
      message: "Acara berakhir harus setelah acara mulai.",
    });
  }
  if (eventEnd !== null && resultAnnouncement !== null && resultAnnouncement < eventEnd) {
    errors.push({
      field: "resultAnnouncementAt",
      relatedField: "eventEndAt",
      message: "Pengumuman hasil harus pada atau setelah acara berakhir.",
    });
  }

  return errors;
};
