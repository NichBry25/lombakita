/*
 * Assertion helpers written the way a real one is, each carrying the same weakness in its body, so
 * a test can ask whether the strength gate can SEE that weakness through every spelling an import
 * takes. `resolvedBodyOf` was blind to two of them and nothing in the repository noticed.
 *
 * Imported only by the fixtures beside this file and by assertion-resolution.test.ts.
 */

/** A status range: the weakness the gate must find inside whichever spelling reaches it. */
export const plain = (r) => r.status >= 400 && r.status < 500;

export const starred = (r) => r.status >= 400 && r.status < 500;

// The anonymous form on purpose: naming it first would resolve through the variable declaration
// and prove nothing. This is the spelling the gate was blind to.
// eslint-disable-next-line import/no-anonymous-default-export
export default (r) => r.status >= 400 && r.status < 500;
