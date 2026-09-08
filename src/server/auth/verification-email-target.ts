import { normalizeEmail } from "@/server/auth/credentials-auth";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * The address a request is asking the platform to mail, normalised for use as a counter key.
 *
 * Shared by /register and /register/resend because they share one per-address budget, and a budget
 * is only shared if both sides derive the same key from the same address. Normalisation goes
 * through `normalizeEmail`, the same function the signup transaction uses to decide which row an
 * address belongs to, so `A@x.com ` and `a@x.com` cannot hold separate allowances while resolving
 * to one account.
 *
 * Returns null when the payload names no address. The caller counts only what it can key.
 */
export const verificationEmailTargetOf = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;

  const email = payload.email;
  if (typeof email !== "string") return null;

  const normalized = normalizeEmail(email);

  return normalized === "" ? null : normalized;
};
