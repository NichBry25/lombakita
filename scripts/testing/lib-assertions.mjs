/*
 * The assertion vocabulary both API harnesses share.
 *
 * It lives here because it was written twice. `api-matrix.mjs` and `r2-flows.mjs` each declared
 * their own `record` with a byte-identical signature, and the strength gate looked at only one of
 * them — so eleven of the twenty-two assertions in the file it did not read were weak by the gate's
 * own definition while the gate reported green. One of those was a cross-tenant IDOR check that
 * passed on whichever status the code happened to answer.
 *
 * Everything here answers the same question: did the response say the thing this assertion names,
 * or merely something compatible with it?
 */

/** Up to 200 characters of a response body, for the human-readable note beside a result. */
export const bodySnippet = (body) =>
  (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200);

// The error code a route names when it refuses. Every refusal is asserted on this rather than on
// the status alone: two different gates answer 403, and an assertion that cannot tell them apart
// passes on whichever one fires.
export const errorCode = (r) => r.body?.error?.code ?? null;

/**
 * A refusal, pinned: the exact status AND the code the route names for it.
 *
 * A status RANGE was the defect. `status >= 400 && status < 500` let CAND-15 pass for four steps
 * while it was being refused by the payload parser — it sent `reason` where the route expects
 * `cancellationReason`, so it never reached the cancellation-policy gate its name claims to test,
 * and a 400 from the parser satisfied the range exactly as a 409 from the gate would have.
 */
export const refusedWith = (r, status, code) => r.status === status && errorCode(r) === code;

/**
 * True when `value` appears as a COMPLETE value somewhere in the response.
 *
 * `JSON.stringify(body).includes("seed-open")` is satisfied by `"seed-open-archive"`, by a slug
 * that merely starts the same way, and by the needle appearing in an unrelated field. Walking the
 * parsed body and comparing whole values is the same assertion with the ambiguity removed.
 */
export const bodyHasValue = (body, value) => {
  const seen = new Set();
  const walk = (node) => {
    if (node === value) return true;
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    return Object.values(node).some(walk);
  };
  return walk(body);
};

/**
 * True when `value` is a URL carrying a complete SigV4 presigned signature.
 *
 * `String(url).includes("X-Amz-Signature")` is satisfied by the name appearing anywhere at all —
 * in a path segment, in an error message quoting it, in a URL whose signature parameter is empty.
 * Parsing the URL and asking its query for the three parameters that make a presigned request
 * valid is the same assertion without the ambiguity.
 */
export const isPresignedUrl = (value) => {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return false;
  }
  const query = url.searchParams;
  return (
    Boolean(query.get("X-Amz-Signature")) &&
    Boolean(query.get("X-Amz-Credential")) &&
    Boolean(query.get("X-Amz-Expires"))
  );
};
