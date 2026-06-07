// Maps competition edit field names to broad, participant-facing change categories (Bahasa
// Indonesia). Used by the competition.edited notification copy so participants learn WHAT KIND of
// change happened (schedule / fees / rules) without the notification leaking the old/new values —
// the competition listing page remains the source of truth.
//
// Pure module — no DB or server-only imports — so it is safe to import from the worker and unit
// test directly.

const CHANGE_CATEGORY_BY_FIELD: Record<string, string> = {
  eventStartAt: "jadwal",
  eventEndAt: "jadwal",
  registrationStartAt: "jadwal",
  registrationEndAt: "jadwal",
  feeAmount: "biaya",
  mode: "format peserta",
  minTeamSize: "format peserta",
  maxTeamSize: "format peserta",
  title: "judul",
  slug: "tautan",
  category: "kategori",
  allowCancellation: "kebijakan pembatalan",
  cancellationCutoffDays: "kebijakan pembatalan",
  description: "deskripsi",
};

// Returns the de-duplicated list of change categories for the given changed field names, preserving
// first-seen order. Unknown fields fall back to "lainnya".
export const summarizeChangeCategories = (fields: string[]): string[] => {
  const categories: string[] = [];
  for (const field of fields) {
    const category = CHANGE_CATEGORY_BY_FIELD[field] ?? "lainnya";
    if (!categories.includes(category)) {
      categories.push(category);
    }
  }
  return categories;
};
