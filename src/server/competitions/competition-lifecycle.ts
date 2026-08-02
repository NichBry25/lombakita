// Shared constants for the competition lifecycle. Kept in a tiny pure module so both
// the unpublish cascade (competition-service) and the competition.cancelled worker reference the
// SAME marker value without a circular import.

// Written to competition_registrations.cancellation_reason for every registration cancelled by an
// institution unpublish-as-cancellation. The competition.cancelled worker selects exactly these
// rows as its recipient set, which also distinguishes them from candidate self-cancellations.
export const INSTITUTION_CANCELLATION_REASON = "competition_cancelled_by_institution";
