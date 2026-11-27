// The sentences of the Email organisasi refusals. The code and confirm routes send them and the
// field shows them, so both read them here.
export const INVALID_EMAIL_MESSAGE = "Alamat email belum benar. Periksa lagi penulisannya.";
export const FREE_DOMAIN_MESSAGE =
  "Pakai email dengan domain organisasi Anda, bukan email pribadi seperti Gmail atau email sementara.";
export const DAILY_LIMIT_MESSAGE =
  "Batas pengiriman kode hari ini sudah tercapai. Coba lagi besok.";
export const NO_CODE_MESSAGE = "Belum ada kode yang aktif. Minta kode terlebih dahulu.";
export const CODE_EXPIRED_MESSAGE = "Kode sudah kedaluwarsa. Minta kode baru.";
export const CODE_LOCKED_MESSAGE = "Kode salah 5 kali. Minta kode baru.";
export const DOMAIN_TRY_LIMIT_MESSAGE =
  "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.";
export const CODE_CHECK_UNAVAILABLE_MESSAGE =
  "Kode belum dapat diperiksa saat ini. Tunggu beberapa menit sebelum mencoba lagi, atau minta kode baru.";
export const EMAIL_TAKEN_MESSAGE =
  "Email ini sudah dipakai akun lain. Satu email organisasi hanya untuk satu akun.";

export const resendTooSoonMessage = (secondsToWait: number): string =>
  `Tunggu ${secondsToWait} detik sebelum meminta kode baru.`;

export const codeInvalidMessage = (attemptsLeft: number): string =>
  `Kode tidak cocok. Sisa percobaan: ${attemptsLeft}.`;
