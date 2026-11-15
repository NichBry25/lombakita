export type FieldValues = Record<string, string>;

// Whether any typed value differs from the value last saved. Surrounding spaces do not count,
// because every save trims them before sending.
export const hasUnsavedFields = (typed: FieldValues, saved: FieldValues): boolean =>
  Object.entries(typed).some(([name, value]) => value.trim() !== (saved[name] ?? "").trim());
