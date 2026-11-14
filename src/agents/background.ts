// The selected workspace's background work (#398): each task its chats have
// running, as the background hook saves it (scripts/hooks/report-background.ts,
// the saved `background` map), for the Details tab's Background work card.
//
// The panel lists what the map holds and keeps no age rule of its own: the
// hook prunes a task no snapshot has listed for its kind's age, in every
// workspace, at the next turn end anywhere, and the native core counts
// against the same limits, so a row clears when the card stops counting it.

import type { SavedTask, TaskType } from "../../scripts/state-config.ts";
import { type Last, markLast } from "../shared/list.ts";
import { SAVED_STATE } from "../shared/persist.ts";
import { ageSince } from "../shared/time.ts";
import { taskWord } from "../shared/words.ts";
import { cur } from "./model.ts";

/** What a row reads of a saved task. The bundle drops `seenEpoch` (scripts/bundle.ts). */
export type ListedTask = Pick<SavedTask, "id" | "type" | "description" | "session" | "startedEpoch">;

export interface BackgroundRow {
  key: string;
  /** Claude Code's description of the task, "npm run check". */
  label: string;
  /** "shell, 2m": its kind, then how long it has run. */
  figure: string;
}

/** A task's kind as one word: the count's word ("shell", "agent"), except a
 * monitor, which a count folds into shells but a row names for what it is. */
export const kindOf = (type: TaskType): string => (type === "monitor" ? "monitor" : taskWord(type, 1));

/** "shell, 2m"; the kind alone without a start or clock. */
export const taskFigure = (t: ListedTask): string =>
  [kindOf(t.type), ageSince(t.startedEpoch)].filter(Boolean).join(", ");

// Oldest first, as the helpers' running rows are (team.ts), so the work
// that has run longest leads and a new task joins at the bottom rather
// than pushing the rest down. The id breaks a tie, so the order is stable.
const byStart = (x: ListedTask, y: ListedTask): number =>
  x.startedEpoch - y.startedEpoch || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** `wsId`'s saved tasks, oldest first; none for a workspace with none saved. */
export function tasksOf(wsId: string): ListedTask[] {
  const map = SAVED_STATE.background;
  const tasks: readonly ListedTask[] = (map && Object.hasOwn(map, wsId) ? map[wsId] : undefined) ?? [];
  return [...tasks].sort(byStart);
}

/** Every background task the selected workspace's chats have running, oldest first. */
export const backgroundRows = computed((): Last<BackgroundRow>[] =>
  markLast(
    tasksOf(cur().ws.id).map((t) => ({
      key: "bg:" + t.session + ":" + t.id,
      label: t.description.trim() || "Background task",
      figure: taskFigure(t),
    })),
  ),
);
