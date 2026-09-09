/**
 * The notice shown when an action succeeded but its email did not go out.
 *
 * The action and the email are separate outcomes and the surface has to report both. Saying only
 * "berhasil" hides a failed notice; saying only "gagal" claims the action did not happen, which is
 * worse. So the caller reports success as it always did and adds one of these warnings on top.
 *
 * Each class gets its own wording because each needs a different response from the reader. A
 * rejected sending identity is a configuration fault that will repeat until somebody fixes it, and
 * telling an operator to "try again" would be false.
 *
 * Typed against the parsed response body rather than the server's own types: this runs in the
 * browser, and the shape it reads is JSON that has already crossed the wire.
 */

export type EmailDeliveryPayload =
  | { delivered: boolean; failureClass?: string | null }
  | null
  | undefined;

const FALLBACK_WARNING =
  "Tindakan berhasil, tetapi email pemberitahuan gagal terkirim. Coba kirim ulang nanti.";

const WARNING_BY_CLASS: Record<string, string> = {
  forbidden:
    "Tindakan berhasil, tetapi email pemberitahuan tidak terkirim karena identitas pengirim " +
    "ditolak. Laporkan ke tim teknis, mencoba lagi tidak akan membantu.",
  reserved_recipient:
    "Tindakan berhasil, tetapi email pemberitahuan tidak dikirim karena alamat tujuan tidak dapat " +
    "menerima email.",
  transient: FALLBACK_WARNING,
};

/**
 * The warning for a delivery outcome, or null when there is nothing to warn about.
 *
 * Returns null both when the email was delivered and when none was due, because neither is
 * something to interrupt the reader with.
 */
export const emailDeliveryWarning = (outcome: EmailDeliveryPayload): string | null => {
  if (!outcome || outcome.delivered) {
    return null;
  }

  const failureClass = outcome.failureClass ?? "";

  return WARNING_BY_CLASS[failureClass] ?? FALLBACK_WARNING;
};
