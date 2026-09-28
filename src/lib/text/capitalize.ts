export const capitalizeFirst = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
};

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
