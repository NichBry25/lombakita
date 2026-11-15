const COUNT_PILL_CAP = 99;

export function CountPill({ count }: { count: number }) {
  const text = count > COUNT_PILL_CAP ? `${COUNT_PILL_CAP}+` : String(count);

  return (
    <span className="status-badge" data-pill="count">
      {text}
    </span>
  );
}
