// Client-side helper for forms that mutate the calling user's own data.
//
// Multi-account / multi-tab race protection: when the same browser carries cookies for two
// accounts at different times, a form rendered for Account A can be submitted while the session
// cookie has flipped to Account B. The server endpoint would then use Account B's session and
// mutate the wrong account silently.
//
// Defense-in-depth: every user-owned mutation request attaches the rendered-for user id via the
// `X-Expected-User-Id` header. The server compares it against `session.user.id` and rejects
// with HTTP 409 `session_user_mismatch` on disagreement. See
// `src/server/auth/access-core.ts#assertSessionMatchesExpectedUser`.
//
// Usage:
//   const res = await sessionFetch(currentUserId, "/api/v1/students/me/eligibility", {
//     method: "PATCH",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify(...),
//   });

export const SESSION_USER_HEADER = "X-Expected-User-Id";
export const SESSION_MISMATCH_CODE = "session_user_mismatch";

export const sessionFetch = (
  expectedUserId: string,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set(SESSION_USER_HEADER, expectedUserId);
  return fetch(input, { ...init, headers, credentials: "include" });
};

// Convenience: extracts the `error.code` from a JSON error envelope without throwing if the
// body isn't JSON. Returns null on any failure to read or parse.
export const readErrorCode = async (response: Response): Promise<string | null> => {
  try {
    const body = await response.clone().json();
    const code = body?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
};

// Human-readable Indonesian message for the session-mismatch error. Surfaced by form
// components when the server responds with 409 session_user_mismatch.
export const SESSION_MISMATCH_MESSAGE =
  "Sesi telah berubah ke akun lain. Muat ulang halaman dan coba lagi.";
