"use client";
import { createContext, useContext, useEffect } from "react";

export const COMPETITION_EDITOR_PART_ORDER = [
  "tags",
  "eligibility",
  "rounds",
  "prizes",
  "fee",
  "contact",
] as const;
export type CompetitionEditorPartKey = (typeof COMPETITION_EDITOR_PART_ORDER)[number];

// The words a failure message names a part with, the same as the part's heading.
export const COMPETITION_EDITOR_PART_LABELS: Record<CompetitionEditorPartKey, string> = {
  tags: "Tag",
  eligibility: "Kelayakan",
  rounds: "Tahapan & linimasa",
  prizes: "Hadiah",
  fee: "Biaya pendaftaran",
  contact: "Kontak untuk peserta",
};

export const describePartLoadFailure = (key: CompetitionEditorPartKey): string =>
  `${COMPETITION_EDITOR_PART_LABELS[key]} gagal dimuat. Muat ulang halaman lalu coba lagi.`;

export type CompetitionPartSaveResult = { ok: true } | { ok: false; errorMessage: string };

export type CompetitionEditorPart = {
  isDirty: boolean;
  // Sends what is on screen. Never throws and shows no toast, because the shell reports the outcome.
  save: () => Promise<CompetitionPartSaveResult>;
};

export type ReportCompetitionEditorPart = (
  key: CompetitionEditorPartKey,
  part: CompetitionEditorPart | null,
) => void;

export const CompetitionEditorPartsContext = createContext<ReportCompetitionEditorPart | null>(
  null,
);

const useReportCompetitionEditorPart = (): ReportCompetitionEditorPart => {
  const reportPart = useContext(CompetitionEditorPartsContext);
  if (reportPart === null) {
    throw new Error("useCompetitionEditorPart must be used within InstitutionCompetitionEditShell");
  }
  return reportPart;
};

export const useCompetitionEditorPart = (
  key: CompetitionEditorPartKey,
  isDirty: boolean,
  save: () => Promise<CompetitionPartSaveResult>,
) => {
  const reportPart = useReportCompetitionEditorPart();
  useEffect(() => {
    reportPart(key, { isDirty, save });
    return () => reportPart(key, null);
  }, [reportPart, key, isDirty, save]);
};
