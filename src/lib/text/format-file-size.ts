// Renders a byte count for display: MB to one decimal at 1 MB and above, whole KB below, with a
// 1 KB floor so a very small file never reads as "0 KB". Client-safe.
export const formatFileSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
