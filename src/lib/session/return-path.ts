const MAX_RETURN_PATH_LENGTH = 512;

const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

// Browsers read "//host" and "/\host" as another site, and drop tab and newline characters
// before they do, so a return address must be a path on this site with neither prefix and no
// control character.
// It also travels as a query parameter in further links, so its length is capped.
export const sameSitePathOr = (candidate: string | null | undefined, fallback: string): string => {
  if (typeof candidate !== "string") return fallback;
  if (candidate.length > MAX_RETURN_PATH_LENGTH) return fallback;
  if (candidate[0] !== "/") return fallback;
  if (candidate[1] === "/" || candidate[1] === "\\") return fallback;
  if (Array.from(candidate).some(isControlCharacter)) return fallback;
  return candidate;
};

const pathOfUrlOnOrigin = (candidate: string, siteOrigin: string): string | null => {
  let url: URL;
  let site: URL;
  try {
    url = new URL(candidate);
    site = new URL(siteOrigin);
  } catch {
    return null;
  }
  if (url.origin !== site.origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
};

// After a failed Google attempt the auth library hands the sign-in page an absolute address on
// this site. Such an address keeps only its path, and every value then passes sameSitePathOr.
export const sameSiteReturnPathOr = (
  candidate: string | null | undefined,
  siteOrigin: string | undefined,
  fallback: string,
): string => {
  if (typeof candidate !== "string" || !siteOrigin) {
    return sameSitePathOr(candidate, fallback);
  }
  const path = pathOfUrlOnOrigin(candidate, siteOrigin);
  return sameSitePathOr(path ?? candidate, fallback);
};
