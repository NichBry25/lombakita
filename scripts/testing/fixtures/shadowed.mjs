/*
 * A helper module with a declaration file beside it. Resolution prefers the `.d.mts`, which has no
 * body, so this is the shape that used to make every assertion behind it read as strong.
 */
export const shadowed = (r) => r.status >= 400 && r.status < 500;
