// What a host is told when a change to a competition is held back. The editor shows each publish
// lock's line under its field, and the refusals that carry a sentence carry these, so a refusal
// and the locked field read alike.
export const PUBLISH_LOCK_REASONS = {
  slug: "Slug tidak dapat diubah setelah kompetisi terbit, agar tautan yang sudah dibagikan tetap berfungsi.",
  mode: "Mode tidak dapat diubah setelah kompetisi terbit.",
  location:
    "Setelah kompetisi terbit, lokasi tidak dapat dikosongkan atau dipersempit. Memilih Hybrid selalu diizinkan.",
  minTeamSize: "Setelah kompetisi terbit, minimum anggota tim hanya dapat diturunkan.",
  maxTeamSize: "Setelah kompetisi terbit, maksimum anggota tim hanya dapat dinaikkan.",
  registrationEndAt: "Setelah kompetisi terbit, pendaftaran hanya dapat diperpanjang.",
  eventStartAt:
    "Setelah kompetisi terbit, tanggal mulai acara hanya dapat diundur, selama acara belum dimulai.",
  eventEndAt: "Setelah acara dimulai, tanggal berakhir acara hanya dapat diundur.",
  allowCancellation: "Setelah kompetisi terbit, izin pembatalan tidak dapat dicabut.",
  cancellationCutoffDays: "Setelah kompetisi terbit, batas pembatalan hanya dapat dikurangi.",
  feeAmount: "Biaya pendaftaran tidak dapat diubah setelah kompetisi terbit.",
} as const;

export type PublishLockedField = keyof typeof PUBLISH_LOCK_REASONS;

export const isPublishLockedField = (field: string): field is PublishLockedField =>
  Object.prototype.hasOwnProperty.call(PUBLISH_LOCK_REASONS, field);

export const CLOSE_WAITS_FOR_TRANSFER_REVIEW_REASON =
  "Pendaftaran belum dapat diperpanjang karena masih ada bukti transfer yang menunggu verifikasi. Verifikasi atau tolak bukti transfer itu terlebih dahulu, lalu simpan lagi.";

export const DRAFT_PRICE_HELD_BY_REGISTRATIONS_REASON =
  "Biaya pendaftaran tidak dapat diubah karena kompetisi ini masih memiliki pendaftar aktif. Hubungi tim Lombakita.";

export const COMPETITION_CHANGED_DURING_EDIT_REASON =
  "Kompetisi ini baru saja diubah atau diterbitkan. Muat ulang halaman lalu coba lagi.";

export const COMPETITION_AUDIENCE_CANNOT_BE_EMPTIED_REASON =
  "Untuk tidak bisa dikosongkan setelah kompetisi terbit. Biarkan minimal satu pilihan.";
