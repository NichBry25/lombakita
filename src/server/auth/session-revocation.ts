/**
 * Whether a token was minted before the account's `sessions_invalid_before` stamp.
 *
 * A token carrying no `signedInAtMs` claim (minted before the claim existed) counts as older than
 * any stamp. Equal is not revoked: a sign-in in the same millisecond as the stamp is the sign-in
 * that follows the password change.
 *
 * A stamp that is neither null nor a valid Date means the account read is broken, not that the
 * account was never revoked, so it revokes.
 */
export const isSessionRevoked = (params: {
  sessionsInvalidBefore: Date | null;
  tokenSignedInAtMs: number | undefined;
}): boolean => {
  if (params.sessionsInvalidBefore === null) return false;
  if (!(params.sessionsInvalidBefore instanceof Date)) return true;
  if (Number.isNaN(params.sessionsInvalidBefore.getTime())) return true;

  const { tokenSignedInAtMs } = params;
  if (typeof tokenSignedInAtMs !== "number" || !Number.isFinite(tokenSignedInAtMs)) return true;

  return tokenSignedInAtMs < params.sessionsInvalidBefore.getTime();
};
