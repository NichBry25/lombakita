export type CompetitionPublishFormValues = {
  title: string;
  description: string;
  category: string;
  mode: string;
  registrationStartAt: string;
  registrationEndAt: string;
  eventStartAt: string;
  eventEndAt: string;
  resultAnnouncementAt: string;
  participantConfirmationAt: string;
};

const REQUIRED_PUBLISH_FIELDS: ReadonlyArray<{
  field: keyof CompetitionPublishFormValues;
  label: string;
}> = [
  { field: "title", label: "Judul" },
  { field: "description", label: "Deskripsi" },
  { field: "category", label: "Kategori" },
  // Mode remains an existing domain requirement because it determines how candidates register.
  { field: "mode", label: "Mode" },
  { field: "registrationStartAt", label: "Pendaftaran mulai" },
  { field: "registrationEndAt", label: "Pendaftaran berakhir" },
  { field: "eventStartAt", label: "Acara mulai" },
  { field: "eventEndAt", label: "Acara berakhir" },
  { field: "resultAnnouncementAt", label: "Pengumuman hasil" },
  { field: "participantConfirmationAt", label: "Konfirmasi peserta" },
];

export const getMissingCompetitionPublishFields = (
  values: CompetitionPublishFormValues,
): string[] =>
  REQUIRED_PUBLISH_FIELDS.filter(({ field }) => values[field].trim() === "").map(
    ({ label }) => label,
  );
