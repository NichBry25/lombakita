// Indonesian copy for the refusals an operator sees when deciding an institution's verification.
//
// The server's own messages are English and are written for a log. This is the translation, kept
// in one client-safe module because two surfaces show the same refusal: the verification queue and
// the institution list. The server module that raises it is not imported here, since it pulls in
// the database client and this file is bundled into the browser.

export const VERIFICATION_REFUSAL_COPY: Record<string, string> = {
  // DEC-0220.
  operator_actor_conflicted:
    "Anda tidak dapat memutuskan verifikasi institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
};

export const resolveVerificationRefusalMessage = (
  error: { code?: string; message?: string } | undefined,
  fallback: string,
): string => {
  const copy = error?.code !== undefined ? VERIFICATION_REFUSAL_COPY[error.code] : undefined;
  return copy ?? error?.message ?? fallback;
};
