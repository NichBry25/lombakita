// What a host is told about a field that publishing locks or lets move one way only. The
// competition editor shows each line under its field, and the fee path refuses a new price with
// the fee's line, so a refusal and the locked field read alike.
export const PUBLISH_LOCK_REASONS = {
  slug: "Slug tidak dapat diubah setelah kompetisi terbit, agar tautan yang sudah dibagikan tetap berfungsi.",
  mode: "Mode tidak dapat diubah setelah kompetisi terbit.",
  minTeamSize: "Setelah kompetisi terbit, minimum anggota tim hanya dapat diturunkan.",
  maxTeamSize: "Setelah kompetisi terbit, maksimum anggota tim hanya dapat dinaikkan.",
  registrationEndAt: "Setelah kompetisi terbit, pendaftaran hanya dapat diperpanjang.",
  eventStartAt:
    "Setelah kompetisi terbit, tanggal mulai acara hanya dapat diundur, selama acara belum dimulai.",
  allowCancellation: "Setelah kompetisi terbit, izin pembatalan tidak dapat dicabut.",
  cancellationCutoffDays: "Setelah kompetisi terbit, batas pembatalan hanya dapat dikurangi.",
  feeAmount: "Biaya pendaftaran tidak dapat diubah setelah kompetisi terbit.",
} as const;

export type PublishLockedField = keyof typeof PUBLISH_LOCK_REASONS;

export const isPublishLockedField = (field: string): field is PublishLockedField =>
  Object.prototype.hasOwnProperty.call(PUBLISH_LOCK_REASONS, field);
