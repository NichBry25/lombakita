// Shape checks on a host's contact details, shared with the organiser contact of a competition.
const MAX_MOBILE_LENGTH = 20;
const MIN_MOBILE_DIGITS = 8;
const MAX_EMAIL_LENGTH = 254;

// Permissive mobile validation: an optional leading `+` followed by digits, spaces, or hyphens.
export const isValidMobileNumber = (trimmed: string): boolean => {
  const digitCount = trimmed.replace(/\D/g, "").length;
  return (
    /^\+?[\d\s-]+$/.test(trimmed) &&
    digitCount >= MIN_MOBILE_DIGITS &&
    trimmed.length <= MAX_MOBILE_LENGTH
  );
};

// A light shape check on an address that is already trimmed and lowercased.
export const isValidEmailAddress = (normalized: string): boolean =>
  normalized.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
