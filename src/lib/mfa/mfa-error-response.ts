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

/**
 * The throttle notice. Deliberately does NOT reuse the lockout copy, and the difference is factual
 * rather than cosmetic: a throttled operator may not have submitted a single wrong code, so telling
 * them the account is locked for wrong codes — and pointing them at support — describes an event
 * that did not happen and invites a support ticket for a condition that clears itself in under a
 * minute. It names the wait and nothing else.
 */
export const describeMfaThrottle = (retryAfterSeconds: number): string => {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const wait = seconds >= 60 ? `sekitar ${Math.ceil(seconds / 60)} menit` : `${seconds} detik`;

  return `Terlalu banyak permintaan verifikasi. Tunggu ${wait} lalu coba lagi.`;
};

/**
 * What an MFA refusal should look like on the page.
 *
 * `panel` is durable page state that stays put (a lockout: fifteen minutes, and it names the only
 * way out — a toast that vanishes in five seconds can carry neither fact). `toast` is transient.
 *
 * EVERY arm is driven by the error CODE, never by the mere presence of `retryAfterSeconds`. Branching
 * on that field is only ever accidentally right: it asks "did the server send a number" when the
 * question is "what happened", and the two answers agree only until some other refusal starts
 * carrying a wait. A 429 carries one, and under a field-driven rule it renders the lockout panel —
 * telling an operator who typed nothing wrong that their account is locked for wrong codes.
 */
export type MfaErrorPresentation =
  // `retryAfterSeconds` is non-optional on this arm so a caller storing it as panel state cannot
  // reach for the nullable field on the payload and end up with `null` in a number slot.
  | { render: "panel"; message: string; retryAfterSeconds: number }
  /**
   * `durationMs` is REQUIRED, not optional, and that is the point: the toast primitive defaults to
   * 5000ms, so a message reading "wait 45 seconds" would disappear after five and take the only
   * piece of information the operator needed with it. Making the field mandatory forces every arm
   * below to state a lifetime rather than inherit one that contradicts its own text. 0 means "until
   * dismissed".
   */
  | { render: "toast"; message: string; durationMs: number };

/**
 * Indonesian copy for every refusal that reaches the transient-toast arm, keyed by error code.
 *
 * The server's `message` is NEVER shown to an operator. Those strings are written for the API
 * surface and are English, so passing one through renders English in an Indonesian product — and it
 * is the ordinary wrong code, the most frequent refusal there is, that takes that path. The two
 * arms above already state their own copy for exactly this reason; this map extends the same rule
 * to the arm that was still forwarding the server's wording.
 *
 * A code absent from this map falls to FALLBACK_MESSAGE rather than to `payload.message`, so a code
 * added later renders a generic Indonesian notice instead of leaking an English one.
 */
const MESSAGE_BY_CODE: Record<string, string> = {
  mfa_invalid_code: "Kode tidak valid. Coba lagi.",
  mfa_invalid_recovery_code:
    "Kode pemulihan tidak valid atau sudah pernah dipakai. Coba kode lain.",
  mfa_already_enrolled: "Akun ini sudah mengaktifkan verifikasi dua langkah.",
  mfa_enrolment_not_found:
    "Sesi pendaftaran tidak ditemukan. Muat ulang halaman ini lalu pindai ulang kode QR.",
  mfa_not_enrolled: "Akun ini belum mengaktifkan verifikasi dua langkah.",
  // Reachable only if a lockout refusal arrives without a duration, which the server does not
  // currently produce. It names no wait, because there is none to name.
  mfa_locked_out: "Terlalu banyak kode salah, jadi akun ini dikunci sementara. Coba lagi nanti.",
};

const FALLBACK_MESSAGE =
  "Verifikasi dua langkah gagal. Coba lagi, atau hubungi tim platform Lombakita jika terus berlanjut.";

// The refusals that mean the account's factor is locked by the database attempt counter. Named
// explicitly so the panel arm asks what happened rather than whether a number arrived: these three
// are the only codes a lockout duration belongs to, and any future code that happens to carry one
// must be added here deliberately rather than inheriting the panel by accident.
const LOCKOUT_CODES = ["mfa_locked_out", "mfa_invalid_code", "mfa_invalid_recovery_code"];

// Redis is unreachable. Two codes, one condition: the limiter refusing because it cannot confirm a
// request is under the ceiling, and the elevation grant refusing because it cannot be minted. They
// are the same outage seen from two points in the same request, so they must not render two
// different ways — one as a persistent Indonesian system notice, the other as a five-second English
// toast ending "try again", which is the false promise this file removed from its sibling.
const UNAVAILABLE_CODES = ["mfa_rate_limit_unavailable", "mfa_elevation_unavailable"];

export const presentMfaError = (payload: MfaErrorPayload): MfaErrorPresentation => {
  if (payload.code === "mfa_rate_limited") {
    const waitSeconds = payload.retryAfterSeconds ?? 60;

    return {
      render: "toast",
      message: describeMfaThrottle(waitSeconds),
      // Lives exactly as long as the wait it describes, so it clears at the moment the server would
      // start accepting requests again — the same self-clearing rule the lockout panel follows. The
      // primitive's 5000ms default would have contradicted the message's own text.
      durationMs: waitSeconds * 1000,
    };
  }

  if (payload.code !== null && UNAVAILABLE_CODES.includes(payload.code)) {
    // Fixed Indonesian copy, NOT `payload.message`. The MFA endpoints' messages are English (they
    // are written for the API surface), and the two codes this function classifies by name are the
    // two whose wording it fully controls — so it states them in the product's language rather than
    // passing the server's string through to an operator.
    //
    // The wording names a SYSTEM fault and deliberately does not promise that waiting fixes it.
    // An earlier draft ended "Coba lagi sebentar lagi" ("try again shortly"), which is the one
    // thing this state must not say: nothing the operator does clears a Redis outage, and inviting
    // them to retry turns a platform failure into a loop that looks like their own mistake. It
    // names the real next step instead.
    return {
      render: "toast",
      message:
        "Verifikasi dua langkah sedang tidak tersedia karena gangguan sistem. Ini bukan kesalahan Anda — hubungi tim platform Lombakita jika terus berlanjut.",
      // Persists until dismissed. "The platform is degraded" is not a five-second fact, and there is
      // no wait to key a lifetime off — waiting is precisely what does not help here.
      durationMs: 0,
    };
  }

  // A lockout — either the refusal while one holds, or the wrong code whose own failure engaged it.
  // Both conditions are required: the code says WHICH refusal this is, and the duration is what the
  // panel renders, so a lockout code arriving without one falls through to the transient toast
  // rather than rendering a panel with nothing to count down.
  if (
    payload.code !== null &&
    LOCKOUT_CODES.includes(payload.code) &&
    payload.retryAfterSeconds !== null
  ) {
    return {
      render: "panel",
      message: describeMfaLockout(payload.retryAfterSeconds),
      retryAfterSeconds: payload.retryAfterSeconds,
    };
  }

  // An ordinary refusal ("wrong code") is genuinely transient and keeps the primitive's default.
  const message =
    (payload.code !== null ? MESSAGE_BY_CODE[payload.code] : undefined) ?? FALLBACK_MESSAGE;

  return { render: "toast", message, durationMs: 5000 };
};
