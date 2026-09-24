export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K`;
  if (abs >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function full(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString("en-US");
}

/** Percent change, or null when there is no meaningful base to compare against. */
export function delta(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || before === 0) return null;
  return ((now - before) / before) * 100;
}

export function formatDelta(d: number | null): string {
  if (d === null) return "-";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}%`;
}

export function relativeTime(date: Date | string | number | null | undefined): string {
  if (!date) return "never";
  const t = new Date(date).getTime();
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
