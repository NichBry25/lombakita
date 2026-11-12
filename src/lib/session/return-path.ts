const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

// Browsers read "//host" and "/\host" as another site, and drop tab and newline characters
// before they do, so a return address must be a path on this site with neither prefix and no
// control character.
export const sameSitePathOr = (candidate: string | null | undefined, fallback: string): string => {
  if (typeof candidate !== "string") return fallback;
  if (candidate[0] !== "/") return fallback;
  if (candidate[1] === "/" || candidate[1] === "\\") return fallback;
  if (Array.from(candidate).some(isControlCharacter)) return fallback;
  return candidate;
};
