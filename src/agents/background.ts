// The selected workspace's background work (#398): each task its chats have
// running, as the background hook saves it (scripts/hooks/report-background.ts,
// the saved `background` map), for the Details tab's Background work card.
//
// Whether any work still runs is the native core's call, as it is for the
// Running status (shared/running.ts): the card lists tasks only while the
// core's saved verdict for the workspace says work runs, and none started
// before the earliest work that verdict counts, so a task the core has let
// go (its chat ended, its age passed) is not listed while the hook's next
// prune is still to come. Two kinds are left out as the card leaves them
// out: an artifact watch, which is not work (running.rs, artifact_watch),
// and a background agent, which the Helpers card already lists.

import type { BakedTask } from "../../scripts/bundle.ts";
import type { TaskType } from "../../scripts/state-config.ts";
import { type Last, markLast } from "../shared/list.ts";
import { SAVED_STATE } from "../shared/persist.ts";
import { ageSince } from "../shared/time.ts";
import { taskWord } from "../shared/words.ts";
import { cur } from "./model.ts";

export interface BackgroundRow {
  key: string;
  /** Claude Code's description of the task, "npm run check". */
  label: string;
  /** "shell, 2m": its kind, then how long it has run. */
  figure: string;
}

/** A task's kind as one word: the count's word ("shell", "session"), except
 * a monitor, which a count folds into shells but a row names for what it is. */
export const kindOf = (type: TaskType): string => (type === "monitor" ? "monitor" : taskWord(type, 1));

/** "shell, 2m"; the kind alone without a start or clock. */
export const taskFigure = (t: BakedTask): string =>
  [kindOf(t.type), ageSince(t.startedEpoch)].filter(Boolean).join(", ");

// The words a comment watch's monitor starts with, as running.rs's
// ARTIFACT_WATCH_PREFIX has them.
const ARTIFACT_WATCH_PREFIX = "live updates for artifact ";

/** Whether a task is listed: work the card would count, not shown elsewhere. */
const listed = (t: BakedTask): boolean =>
  t.type !== "subagent" && !(t.type === "monitor" && t.description.startsWith(ARTIFACT_WATCH_PREFIX));

// Oldest first, as the helpers' running rows are (team.ts), so the work
// that has run longest leads and a new task joins at the bottom rather
// than pushing the rest down. The id breaks a tie, so the order is stable.
const byStart = (x: BakedTask, y: BakedTask): number =>
  x.startedEpoch - y.startedEpoch || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** `wsId`'s running background tasks, oldest first; none while the core's
 * verdict says nothing runs there. */
export function tasksOf(wsId: string): BakedTask[] {
  const verdicts = SAVED_STATE.running;
  const since = verdicts && Object.hasOwn(verdicts, wsId) ? verdicts[wsId]?.since : undefined;
  if (since === undefined) return [];
  const map = SAVED_STATE.background;
  const tasks = (map && Object.hasOwn(map, wsId) ? map[wsId] : undefined) ?? [];
  return tasks.filter((t) => t.startedEpoch >= since && listed(t)).sort(byStart);
}

/** Every background task the selected workspace's chats have running, oldest first. */
export const backgroundRows = computed((): Last<BackgroundRow>[] =>
  markLast(
    tasksOf(cur().ws.id).map((t) => ({
      key: "bg:" + t.session + ":" + t.id,
      label: t.description,
      figure: taskFigure(t),
    })),
  ),
);
