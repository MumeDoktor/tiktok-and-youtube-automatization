/**
 * Minimal IANA timezone helpers built on Intl, so posting windows expressed in
 * an account local time land on the correct UTC instant across DST changes.
 */

/** Offset of `timeZone` from UTC, in ms, at the given instant. */
export function offsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );

  return asUtc - instant.getTime();
}

/** The wall-clock fields an instant shows in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string) {
  const off = offsetMs(instant, timeZone);
  const shifted = new Date(instant.getTime() + off);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dayOfWeek: shifted.getUTCDay(),
  };
}

/**
 * The UTC instant at which `timeZone` reads the given wall-clock time.
 * Applies the offset twice, which resolves the DST-boundary case where the
 * first guess lands on the wrong side of a transition.
 */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute?: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute ?? 0,
    0,
  );

  let instant = new Date(naive - offsetMs(new Date(naive), timeZone));
  instant = new Date(naive - offsetMs(instant, timeZone));
  return instant;
}

export type Window = { dayOfWeek: number; hourLocal: number; score: number };

/**
 * Expands ranked posting windows into the next `count` concrete UTC instants,
 * chronologically, skipping anything already in the past.
 */
export function nextSlots(
  windows: Window[],
  timeZone: string,
  count: number,
  { from = new Date(), minGapMinutes = 90, horizonDays = 14 } = {},
): Date[] {
  if (windows.length === 0) return [];

  const ranked = [...windows].sort((a, b) => b.score - a.score);
  const candidates: Array<{ at: Date; score: number }> = [];
  const here = zonedParts(from, timeZone);

  for (let offset = 0; offset <= horizonDays; offset++) {
    for (const w of ranked) {
      const at = zonedTimeToUtc(
        {
          year: here.year,
          month: here.month,
          day: here.day + offset,
          hour: w.hourLocal,
        },
        timeZone,
      );
      if (zonedParts(at, timeZone).dayOfWeek !== w.dayOfWeek) continue;
      if (at.getTime() <= from.getTime()) continue;
      candidates.push({ at, score: w.score });
    }
  }

  candidates.sort((a, b) => a.at.getTime() - b.at.getTime());

  const chosen: Date[] = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    const last = chosen[chosen.length - 1];
    if (last && c.at.getTime() - last.getTime() < minGapMinutes * 60_000) continue;
    chosen.push(c.at);
  }

  return chosen;
}
