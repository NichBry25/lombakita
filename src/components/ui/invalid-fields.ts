const INVALID_FIELD_SELECTOR = '[aria-invalid="true"]';

export const findInvalidFields = (container: HTMLElement | null): HTMLElement[] => {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(INVALID_FIELD_SELECTOR));
};

// Moves focus to the first field the form marks as invalid and scrolls it into view. The caller
// runs this after the render that enables the form, because a disabled field cannot take focus.
export const focusFirstInvalidField = (container: HTMLElement | null): void => {
  const firstInvalidField = findInvalidFields(container)[0];
  if (!firstInvalidField) return;
  firstInvalidField.focus();
  firstInvalidField.scrollIntoView({ block: "center" });
};
