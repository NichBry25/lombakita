import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/notifications/saved-deadline-reminder-message");

import { describeDeadlineCountdown } from "@/lib/competitions/deadline-countdown";

// The words of a saved-deadline reminder, for both channels. Kept apart from the sender so the
// copy can be checked without a mail provider, and so the email and the inbox row count down with
// the same phrase the site's countdown chips use ("Sisa 3 hari", "Hari terakhir").

export type SavedDeadlineReminderItem = {
  competitionTitle: string;
  competitionSlug: string;
  institutionSlug: string;
  registrationEndAt: Date;
};

// Pinned to WIB and labelled as such. The worker's clock is UTC, and a deadline shown in UTC is
// seven hours wrong for most readers; a time with no zone is a guess for the rest.
export const formatDeadlineWib = (date: Date): string =>
  `${date.toLocaleString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  })} WIB`;

// Counted from the sweep's anchor rather than from whenever the job happens to run, so a retried
// job still says what the student was told the band means.
const countdownLabel = (item: SavedDeadlineReminderItem, anchor: Date): string =>
  describeDeadlineCountdown(item.registrationEndAt, anchor)?.label ?? "Segera ditutup";

export const buildSavedDeadlineReminderEmail = (
  items: SavedDeadlineReminderItem[],
  anchor: Date,
  baseUrl: string,
): { subject: string; text: string } => {
  const [first] = items;
  const subject =
    items.length === 1 && first
      ? `${countdownLabel(first, anchor)} — ${first.competitionTitle}`
      : `${items.length} kompetisi tersimpanmu segera ditutup`;

  const entries = items.flatMap((item) => [
    `• ${item.competitionTitle} — ${countdownLabel(item, anchor)}`,
    `  Pendaftaran ditutup ${formatDeadlineWib(item.registrationEndAt)}`,
    `  ${baseUrl}/competitions/${encodeURIComponent(item.institutionSlug)}/${encodeURIComponent(
      item.competitionSlug,
    )}`,
    "",
  ]);

  const text = [
    items.length === 1
      ? "Kompetisi yang kamu simpan di Lombakita segera menutup pendaftaran:"
      : "Beberapa kompetisi yang kamu simpan di Lombakita segera menutup pendaftaran:",
    "",
    ...entries,
    // The way out is the same action that opted in. There is no preference page yet, and a
    // reminder with no stated way to stop it is the kind that gets marked as spam.
    `Kamu menerima pengingat ini karena menyimpan kompetisi di atas. Hapus dari daftar tersimpan untuk berhenti menerima pengingatnya: ${baseUrl}/saved`,
  ].join("\n");

  return { subject, text };
};

export const buildSavedDeadlineReminderInbox = (
  items: SavedDeadlineReminderItem[],
  anchor: Date,
): { title: string; body: string } => {
  const [first] = items;
  const title =
    items.length === 1 && first
      ? `${countdownLabel(first, anchor)}: ${first.competitionTitle}`
      : `${items.length} kompetisi tersimpan segera ditutup`;

  const body = items
    .map(
      (item) =>
        `"${item.competitionTitle}": ${countdownLabel(item, anchor).toLowerCase()}, ditutup ${formatDeadlineWib(item.registrationEndAt)}.`,
    )
    .join(" ");

  return { title, body };
};
