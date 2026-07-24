export const capitalizeFirst = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
};

// Use for single-word display values whose stored form is already suitable for presentation
// apart from its initial lowercase letter.
export const capitalizeWord = (value: string | null | undefined): string => capitalizeFirst(value);

// Unknown enum values still need a safe display fallback. Convert storage separators and
// camelCase boundaries into a sentence-case label instead of exposing a raw token.
export const formatDisplayToken = (value: string | null | undefined): string => {
  if (!value) return "";

  const normalized = value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("id-ID");

  return capitalizeFirst(normalized);
};
