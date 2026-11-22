import {
  getMissingCompetitionPublishFields,
  type CompetitionPublishFormValues,
} from "@/lib/competitions/competition-publish-required-fields";

export type CompetitionStep = 1 | 2 | 3 | 4 | 5;

export const COMPETITION_STEP_COUNT = 5;

export const COMPETITION_STEP_TITLES: Record<CompetitionStep, string> = {
  1: "Informasi dasar",
  2: "Peserta",
  3: "Jadwal",
  4: "Hadiah dan biaya",
  5: "Tinjau dan terbitkan",
};

// Keyed by the labels getMissingCompetitionPublishFields reports.
const STEP_BY_MISSING_FIELD_LABEL: Record<string, CompetitionStep> = {
  Judul: 1,
  Deskripsi: 1,
  Kategori: 1,
  Mode: 2,
  Lokasi: 2,
  "Pendaftaran mulai": 3,
  "Pendaftaran berakhir": 3,
  "Acara mulai": 3,
  "Acara berakhir": 3,
  "Pengumuman hasil": 3,
  "Konfirmasi peserta": 3,
};

export type CompetitionResumeValues = CompetitionPublishFormValues & {
  minTeamSize: string;
  maxTeamSize: string;
};

const stepOfMissingField = (label: string): CompetitionStep => {
  const step = STEP_BY_MISSING_FIELD_LABEL[label];
  if (step === undefined) {
    throw new Error(`No competition step holds the missing field "${label}"`);
  }
  return step;
};

const hasMissingTeamSize = ({ mode, minTeamSize, maxTeamSize }: CompetitionResumeValues) => {
  const isTeamMode = mode === "team" || mode === "both";
  if (isTeamMode && maxTeamSize === "") return true;
  return mode === "team" && minTeamSize === "";
};

/** The first step that holds a field the draft still needs before it can be published. */
export const getCompetitionResumeStep = (values: CompetitionResumeValues): CompetitionStep => {
  const missingSteps = getMissingCompetitionPublishFields(values).map(stepOfMissingField);
  if (hasMissingTeamSize(values)) missingSteps.push(2);
  if (missingSteps.length === 0) return 5;
  return Math.min(...missingSteps) as CompetitionStep;
};

export const getCompetitionStepHref = (
  institutionSlug: string,
  competitionSlug: string,
  step: CompetitionStep,
): string =>
  `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionSlug)}/edit?langkah=${step}`;
