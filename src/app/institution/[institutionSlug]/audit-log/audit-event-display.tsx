import type { ReactNode } from "react";
import { LocalDate } from "@/components/ui/local-date";
import { getInstitutionRoleLabel } from "@/lib/access/role-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { REVIEW_STATUS_LABELS } from "@/app/institution/[institutionSlug]/competitions/[competitionSlug]/participants/review-status-labels";

type AuditMetadata = Record<string, unknown>;

const EVENT_NAMES: Record<string, string> = {
  "member.role_changed": "Peran anggota diubah",
  "member.removed": "Anggota dihapus",
  result_published: "Hasil dipublikasikan",
  result_unpublished: "Publikasi hasil dibatalkan",
  review_status_changed: "Tinjauan diperbarui",
  "submission.file_accessed": "Berkas karya dibuka",
  "payment_proof.file_accessed": "Bukti pembayaran dibuka",
  "document_request.created": "Permintaan dokumen dibuat",
  "document_request.reviewed": "Permintaan dokumen ditinjau",
  "document_request.deadline_extended": "Tenggat permintaan diperpanjang",
  "document_request.cancelled": "Permintaan dokumen dibatalkan",
  "document_request.file_accessed": "Berkas permintaan dokumen dibuka",
};

const DOCUMENT_REVIEW_VERDICT_LABELS: Record<string, string> = {
  accept: "Diterima",
  reject: "Ditolak",
};

// An action with no name yet keeps its English reading, so a new event is never hidden.
export const auditEventName = (action: string): string =>
  EVENT_NAMES[action] ?? formatDisplayToken(action);

const asMetadata = (value: unknown): AuditMetadata => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as AuditMetadata;
};

const textField = (metadata: AuditMetadata, key: string): string | null => {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
};

const numberField = (metadata: AuditMetadata, key: string): number | null => {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const roleChangeSummary = (metadata: AuditMetadata): string | null => {
  const from = textField(metadata, "from");
  const to = textField(metadata, "to");
  if (!from || !to) return null;
  return `${getInstitutionRoleLabel(from)} menjadi ${getInstitutionRoleLabel(to)}`;
};

const removedMemberSummary = (metadata: AuditMetadata): string | null => {
  const removedRole = textField(metadata, "removedRole");
  if (!removedRole) return null;
  return `Peran saat dihapus: ${getInstitutionRoleLabel(removedRole)}`;
};

const publishedResultSummary = (metadata: AuditMetadata): string | null => {
  const resultLabel = textField(metadata, "resultLabel");
  if (!resultLabel) return null;
  return `Hasil: ${resultLabel}`;
};

// A review that saved only its notes stores no new status, and the notes themselves are not stored.
const reviewStatusSummary = (metadata: AuditMetadata): string => {
  const newStatus = textField(metadata, "newStatus");
  if (!newStatus) return "Catatan diperbarui";
  const label = REVIEW_STATUS_LABELS[newStatus as keyof typeof REVIEW_STATUS_LABELS];
  return `Status baru: ${label ?? formatDisplayToken(newStatus)}`;
};

const submissionFileSummary = (metadata: AuditMetadata): string | null => {
  const fileName = textField(metadata, "fileName");
  const version = numberField(metadata, "version");
  if (!fileName || version === null) return null;
  return `${fileName}, versi ${version}`;
};

// `attempt` counts from zero, so the first submission reads "Percobaan 1".
const paymentProofSummary = (metadata: AuditMetadata): string | null => {
  const attempt = numberField(metadata, "attempt");
  if (attempt === null) return null;
  return `Percobaan ${attempt + 1}`;
};

const documentReviewSummary = (metadata: AuditMetadata): string | null => {
  const verdict = textField(metadata, "verdict");
  if (!verdict) return null;
  return DOCUMENT_REVIEW_VERDICT_LABELS[verdict] ?? null;
};

const extendedDeadlineSummary = (metadata: AuditMetadata): ReactNode => {
  const dueAt = textField(metadata, "dueAt");
  if (!dueAt || Number.isNaN(new Date(dueAt).getTime())) return null;
  return (
    <>
      Tenggat baru <LocalDate value={dueAt} format="shortDateTime" />
    </>
  );
};

// One short line built from the fields the event carries. Free text such as a rejection note is
// never part of it, and an event with nothing useful to say returns null.
export const auditEventSummary = (action: string, rawMetadata: unknown): ReactNode => {
  const metadata = asMetadata(rawMetadata);
  switch (action) {
    case "member.role_changed":
      return roleChangeSummary(metadata);
    case "member.removed":
      return removedMemberSummary(metadata);
    case "result_published":
      return publishedResultSummary(metadata);
    case "review_status_changed":
      return reviewStatusSummary(metadata);
    case "submission.file_accessed":
      return submissionFileSummary(metadata);
    case "payment_proof.file_accessed":
      return paymentProofSummary(metadata);
    case "document_request.created":
      return textField(metadata, "title");
    case "document_request.reviewed":
      return documentReviewSummary(metadata);
    case "document_request.deadline_extended":
      return extendedDeadlineSummary(metadata);
    default:
      return null;
  }
};

const stringifyStoredValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
};

// Every stored key and value as it is, uncut and untranslated.
export const auditEventDataEntries = (
  rawMetadata: unknown,
): Array<{ key: string; value: string }> =>
  Object.entries(asMetadata(rawMetadata)).map(([key, value]) => ({
    key,
    value: stringifyStoredValue(value),
  }));
