// The Context card at the foot of the agents panel: how full the selected
// workspace's chat is, and how much of the plan's 5-hour and weekly
// allowance is used. scripts/hooks/status-context.ts puts both on each
// workspace's description from the status line. The chat's figure is the
// selected workspace's own; the plan's is account-wide, so it is the newest
// reading any workspace carries, since an idle chat's copy goes stale.

import { type SavedContext, splitContext } from "../../scripts/state-config.ts";
import { type Last, markLast } from "../shared/list.ts";
import { nowEpoch } from "../shared/time.ts";
import { current } from "./model.ts";
import { METER_FILL, METER_TRACK, METER_WARN, T } from "./theme.ts";

/** A meter shows amber from this percent up: the chat will soon compact, or the plan run out. */
export const WARN_AT = 80;

export interface Meter {
  key: string;
  label: string;
  /** 0 to 100. */
  percent: number;
  /** The faint line under the bar, "" for none. */
  detail: string;
}

// The context a description carries, parsed once per distinct description:
// meters are read on every tick, for every workspace.
const parsed = new Map<string, SavedContext | null>();
function contextOf(d: string | undefined): SavedContext | null {
  if (d === undefined) return null;
  const hit = parsed.get(d);
  if (hit !== undefined) return hit;
  if (parsed.size >= 64) parsed.clear();
  const c = splitContext(d).context;
  parsed.set(d, c);
  return c;
}

/** A token count the short way: "950", "178k", "1M", "1.5M". */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  // Below 999,500 rounds to at most 999k; from there it reads as 1M.
  if (n < 999_500) return Math.round(n / 1000) + "k";
  const m = Math.round(n / 100_000) / 10;
  return String(m) + "M";
}

/** When a limit resets, from `now`: "Resets in 40m", "Resets in 3h", "Resets in 2 days". */
export function resetsIn(at: number, now: number): string {
  const secs = at - now;
  if (secs < 3600) return "Resets in " + Math.max(1, Math.ceil(secs / 60)) + "m";
  if (secs < 86400) return "Resets in " + Math.floor(secs / 3600) + "h";
  const days = Math.floor(secs / 86400);
  return "Resets in " + days + (days === 1 ? " day" : " days");
}

function chatMeter(c: SavedContext): Meter {
  const { tokens, size } = c;
  const detail = tokens !== undefined && size ? shortCount(tokens) + " of " + shortCount(size) : "";
  return { key: "chat", label: "This chat", percent: c.used, detail };
}

// A plan limit's meter; one whose reset time has passed reads as empty
// until a chat reports again.
function limitMeter(key: string, label: string, used: number, reset: number | undefined, now: number): Meter {
  if (reset !== undefined && now > 0 && reset <= now) return { key, label, percent: 0, detail: "Reset" };
  return { key, label, percent: used, detail: reset !== undefined && now > 0 ? resetsIn(reset, now) : "" };
}

// The newest context any workspace carries that has the plan's figures.
function newestPlan(): SavedContext | null {
  let best: SavedContext | null = null;
  for (const w of data.workspaces() ?? []) {
    const c = contextOf(w.description);
    if (c && (c.hour !== undefined || c.week !== undefined) && (!best || c.epoch > best.epoch)) best = c;
  }
  return best;
}

function planMeters(now: number): Meter[] {
  const p = newestPlan();
  if (!p) return [];
  return [
    ...(p.hour !== undefined ? [limitMeter("hour", "Your plan, 5 hours", p.hour, p.hourReset, now)] : []),
    ...(p.week !== undefined ? [limitMeter("week", "Your plan, this week", p.week, p.weekReset, now)] : []),
  ];
}

/** The card's meters, top to bottom: this chat, then the plan's two limits; empty when nothing has reported. */
export const contextMeters = computed((): Last<Meter>[] => {
  const cur = current();
  // An ended chat's tail stays on the description, so it shows only while
  // the workspace has a chat that has not ended.
  const live = cur?.agents.some((a) => a.status !== "ended") ?? false;
  const chat = live ? contextOf(cur?.ws.description) : null;
  return markLast([...(chat ? [chatMeter(chat)] : []), ...planMeters(nowEpoch())]);
});

/** The percent's colour: amber from WARN_AT up, else the quiet grey. */
export const percentColor = (m: Meter): string => (m.percent >= WARN_AT ? T.amberText : T.secondary);

/** The bar's steps, each 5%. */
export const STEPS = 20;

/** Step `i`'s colour: filled once the percent reaches its share, amber from
 * WARN_AT up; a percent above 0 always fills the first step, so a fresh
 * chat never reads as empty. */
export function stepColor(m: Meter, i: number): string {
  const filled = m.percent > 0 && i < Math.max(1, Math.round(m.percent / (100 / STEPS)));
  if (!filled) return METER_TRACK;
  return m.percent >= WARN_AT ? METER_WARN : METER_FILL;
}
