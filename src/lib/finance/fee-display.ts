// How a platform fee RATE reads to a human, shared by every surface that shows one.
//
// Lifted out of the fee-rule admin route once a second segment needed it: the institution's own fee
// statement renders the rate that was snapshotted onto each accrual, and importing a helper across
// route segments couples two features that have no reason to know about each other.

// 250 basis points reads as "2,5%": Indonesian decimal comma, and no trailing ",0" on a whole
// percent. The stored unit is basis points; this is the only place it becomes a percentage.
export const formatBasisPoints = (basisPoints: number): string => {
  const percent = basisPoints / 100;

  return `${percent.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
};
