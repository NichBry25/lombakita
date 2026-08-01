import { formatDisplayToken } from "@/lib/text/capitalize";

const COMPETITION_FIELD_LABELS: Record<string, string> = {
  title: "Judul",
  description: "Deskripsi",
  category: "Kategori",
  mode: "Format peserta (mode)",
  minTeamSize: "Minimum anggota tim",
  maxTeamSize: "Maksimum anggota tim",
  registrationStartAt: "Pendaftaran mulai",
  registrationEndAt: "Pendaftaran berakhir",
  eventStartAt: "Acara mulai",
  eventEndAt: "Acara berakhir",
  resultAnnouncementAt: "Pengumuman hasil",
  minimumParticipantEntries: "Minimum peserta",
  participantConfirmationAt: "Konfirmasi peserta",
  feeAmount: "Biaya",
};

export const getCompetitionFieldLabel = (field: string): string =>
  COMPETITION_FIELD_LABELS[field] ?? formatDisplayToken(field);
