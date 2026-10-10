import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { accounts, jobs, type Account, type Job } from "@/db/schema";
import { env } from "@/lib/env";
import { zonedParts, zonedTimeToUtc } from "@/lib/tz";
import { latestAnalysis, type HardStats } from "./account-analysis";
import { enqueue, logEvent } from "./events";

/**
 * Autopilot: a finished video waiting ahead of each of the account's best
 * posting times.
 *
 * The app cannot post - its TikTok scopes are read-only - so publishing here
 * means the video is done before the slot and the owner is told when to put it
 * up. Production starts a lead time ahead of the slot rather than at it,
 * because a render takes minutes and an After Effects edit waits on a person.
 *
 * Planning is light enough to run on every worker tick and from a web request;
 * the production itself is produceForSlot in produce.ts.
 */

export type AutopilotPayload = {
  /** The posting slot, epoch ms. */
  slotAt: number;
  /** Why this slot, from the measured stats. */
  why: string;
};

export type PostingWindow = {
  dayOfWeek: number;
  hourLocal: number;
  /** Only fixed slots sit off the hour. */
  minuteLocal?: number;
  /** 1 for the strongest day, relative below that. */
  score: number;
  hourWhy: string;
  dayWhy: string;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * How many posts a bucket needs before its own median outweighs the account's.
 *
 * A best hour measured on two videos is mostly luck: one post that took off puts
 * it on top. Blending each median toward the account median by this many posts
 * lets 26 videos at 10:00 compete fairly with 2 at 19:00 instead of losing to
 * them outright - the two still win if they are far enough ahead.
 */
const PRIOR_POSTS = 5;

function shrink(median: number, n: number, overall: number): number {
  return (n * median + PRIOR_POSTS * overall) / (n + PRIOR_POSTS);
}

export function hourLabel(hour: number, minute = 0): string {
  const mm = minute ? `:${String(minute).padStart(2, "0")}` : "";
  return `${hour % 12 || 12}${mm} ${hour < 12 ? "AM" : "PM"}`;
}

export function windowLabel(
  w: Pick<PostingWindow, "dayOfWeek" | "hourLocal" | "minuteLocal">,
): string {
  return `${DAYS[w.dayOfWeek].slice(0, 3)} ${hourLabel(w.hourLocal, w.minuteLocal)}`;
}

/** Whether autopilot posts at AUTOPILOT_SLOTS rather than at measured best hours. */
export function fixedSlots(): boolean {
  return env.autopilotSlots.length > 0;
}

/** AUTOPILOT_SLOTS on every day of the week. */
function fixedWindows(): PostingWindow[] {
  return [0, 1, 2, 3, 4, 5, 6].flatMap((day) =>
    env.autopilotSlots.map((s) => ({
      dayOfWeek: day,
      hourLocal: s.hour,
      minuteLocal: s.minute,
      score: 1,
      hourWhy: `Fixed time ${hourLabel(s.hour, s.minute)} (AUTOPILOT_SLOTS)`,
      dayWhy: "every day",
    })),
  );
}

/** e.g. "Sat 7:00 PM", in the account's own timezone. */
export function formatSlot(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/**
 * The week's posting windows: the strongest measured hour, on the `perWeek`
 * strongest days.
 *
 * One hour for every day, because day-by-hour buckets are far too thin to
 * measure on an account posting a few times a week. A day with too few posts
 * to rank sits at the account median - neither favoured nor avoided.
 */
export function postingWindows(
  stats: Pick<HardStats, "bestHours" | "bestDays" | "medianViews">,
  perWeek: number,
): PostingWindow[] {
  const overall = stats.medianViews;
  if (!stats.bestHours?.length || !overall || overall <= 0) return [];

  const hour = stats.bestHours
    .map((h) => ({ ...h, est: shrink(h.medianViews, h.n, overall) }))
    .sort((a, b) => b.est - a.est)[0];

  const measured = new Map((stats.bestDays ?? []).map((d) => [d.day, d]));
  const days = [0, 1, 2, 3, 4, 5, 6]
    .map((day) => {
      const d = measured.get(day);
      return { day, d, factor: d ? shrink(d.medianViews, d.n, overall) / overall : 1 };
    })
    .sort((a, b) => b.factor - a.factor)
    .slice(0, Math.max(1, Math.min(7, Math.round(perWeek))));

  const top = days[0].factor;
  const hourWhy = `${hourLabel(hour.hour)} posts get a median ${hour.medianViews.toLocaleString()} views (n=${hour.n})`;

  return days
    .map(({ day, d, factor }) => ({
      dayOfWeek: day,
      hourLocal: hour.hour,
      score: Number((factor / top).toFixed(2)),
      hourWhy,
      dayWhy: d
        ? `${DAYS[day]}s: median ${d.medianViews.toLocaleString()} views (n=${d.n})`
        : `${DAYS[day]}: too few posts to rank the day`,
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

/** The earliest window instant at or after `earliest`, or null if none within nine days. */
export function nextSlot(windows: PostingWindow[], timeZone: string, earliest: Date): Date | null {
  const here = zonedParts(earliest, timeZone);
  let best: Date | null = null;

  for (let offset = 0; offset <= 8; offset++) {
    for (const w of windows) {
      const at = zonedTimeToUtc(
        {
          year: here.year,
          month: here.month,
          day: here.day + offset,
          hour: w.hourLocal,
          minute: w.minuteLocal ?? 0,
        },
        timeZone,
      );
      if (zonedParts(at, timeZone).dayOfWeek !== w.dayOfWeek) continue;
      if (at.getTime() < earliest.getTime()) continue;
      if (!best || at.getTime() < best.getTime()) best = at;
    }
  }

  return best;
}

/** The account's windows from its latest analysis, or the reason there are none. */
export function accountWindows(account: Account): {
  windows: PostingWindow[];
  blocked: string | null;
} {
  if (fixedSlots()) return { windows: fixedWindows(), blocked: null };

  const raw = latestAnalysis(account.id)?.rawAnalysis;
  let stats: HardStats | undefined;
  try {
    stats = raw ? (JSON.parse(raw) as { stats?: HardStats }).stats : undefined;
  } catch {
    stats = undefined;
  }

  if (!stats) {
    return {
      windows: [],
      blocked: "No analysis yet. Sync the account and it is read automatically.",
    };
  }

  const windows = postingWindows(stats, env.autopilotPerWeek);
  if (windows.length === 0) {
    return {
      windows,
      blocked: "No hour has 2+ posts yet, so there is no measured best time to aim at.",
    };
  }
  return { windows, blocked: null };
}

export function readAutopilotPayload(job: Pick<Job, "payload">): AutopilotPayload | null {
  try {
    const p = JSON.parse(job.payload) as Partial<AutopilotPayload>;
    return typeof p.slotAt === "number" ? { slotAt: p.slotAt, why: p.why ?? "" } : null;
  } catch {
    return null;
  }
}

export function pendingAutopilotJob(accountId: string) {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.accountId, accountId),
        eq(jobs.type, "autopilot"),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .get();
}

/** The latest slot ever planned and not cancelled, epoch ms - so no slot is made twice. */
function lastPlannedSlot(accountId: string): number {
  const recent = db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.accountId, accountId), eq(jobs.type, "autopilot"), ne(jobs.status, "cancelled")),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(20)
    .all();
  return Math.max(0, ...recent.map((j) => readAutopilotPayload(j)?.slotAt ?? 0));
}

/**
 * Makes sure the account has its next slot planned.
 *
 * Only one slot is ever queued ahead. The next is planned once that one has
 * run, so a re-analysis that moves the best hour takes effect from the
 * following video rather than leaving a week of stale plans behind it.
 */
export function planAutopilot(account: Account): Job | null {
  if (!account.autopilot || account.status !== "active") return null;

  const pending = pendingAutopilotJob(account.id);
  if (pending) return pending;

  const { windows } = accountWindows(account);
  if (windows.length === 0) return null;

  const leadMs = env.autopilotLeadMinutes * 60_000;
  const earliest = Math.max(Date.now() + leadMs, lastPlannedSlot(account.id) + 60 * 60_000);
  const slot = nextSlot(windows, account.timezone, new Date(earliest));
  if (!slot) return null;

  const at = zonedParts(slot, account.timezone);
  const window =
    windows.find(
      (w) => w.dayOfWeek === at.dayOfWeek && w.hourLocal === at.hour && (w.minuteLocal ?? 0) === at.minute,
    ) ??
    windows.find((w) => w.dayOfWeek === at.dayOfWeek) ??
    windows[0];
  const why = `${window.hourWhy}; ${window.dayWhy}`;
  const runAt = new Date(slot.getTime() - leadMs);

  const payload: AutopilotPayload = { slotAt: slot.getTime(), why };
  const job = enqueue({
    accountId: account.id,
    type: "autopilot",
    runAt,
    payload,
    // A production is minutes of rendering and real API spend. A failure is
    // reported and the next slot planned, rather than retried into the slot.
    maxAttempts: 1,
  });

  logEvent({
    accountId: account.id,
    type: "autopilot.planned",
    message:
      `Next video for ${formatSlot(slot, account.timezone)} - production starts ` +
      `${formatSlot(runAt, account.timezone)}. ${why}`,
    meta: payload,
  });

  return job;
}

/** Drops the queued slot. One already being made is left to finish. */
export function cancelAutopilot(accountId: string): number {
  return db
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(
      and(eq(jobs.accountId, accountId), eq(jobs.type, "autopilot"), eq(jobs.status, "queued")),
    )
    .run().changes;
}

/** " Post at Sat 7:00 PM." for a clip made for a slot, "" for one asked for by hand. */
export function postBy(clip: { accountId: string; scheduledFor: Date | null }): string {
  if (!clip.scheduledFor) return "";
  const account = db.select().from(accounts).where(eq(accounts.id, clip.accountId)).get();
  return ` Post at ${formatSlot(clip.scheduledFor, account?.timezone ?? "UTC")}.`;
}
