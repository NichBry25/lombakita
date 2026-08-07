// Client-safe reading of what an MFA endpoint refused with. Pure: no imports, no server modules, so
// both MFA forms share one parse and one piece of lockout copy instead of keeping their own.

export type MfaErrorPayload = {
  code: string | null;
  message: string | null;
  /**
   * Seconds until the account's factor unlocks, or null when it is not locked. Set on the
   * invalid-code refusal that ENGAGED the lock as well as on every refusal while it holds, which is
   * what lets a form tell the operator about the lock on the attempt that caused it.
   */
  retryAfterSeconds: number | null;
};

const readRetryAfterSeconds = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};

export const readMfaErrorPayload = async (response: Response): Promise<MfaErrorPayload> => {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown; retryAfterSeconds?: unknown };
  } | null;

  const error = body?.error;

  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
    retryAfterSeconds: readRetryAfterSeconds(error?.retryAfterSeconds),
  };
};

/**
 * The lockout notice, in Indonesian, naming both the wait and the way out. It names support because
 * an operator who has lost the authenticator AND the recovery codes has no self-service path left —
 * a reset is deliberately human-mediated — and a notice that only says "try again later" sends that
 * person back to fail five more times.
 */
export const describeMfaLockout = (retryAfterSeconds: number): string => {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const wait = minutes <= 1 ? "sekitar satu menit" : `sekitar ${minutes} menit`;

  return `Terlalu banyak kode salah, jadi akun ini dikunci sementara. Coba lagi dalam ${wait}. Jika Anda kehilangan akses ke aplikasi autentikator dan kode pemulihan, hubungi dukungan Lombakita untuk mengatur ulang verifikasi dua langkah.`;
};
