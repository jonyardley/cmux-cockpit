// A card's chips: the move size, the PR, the branch and the ports, and its To review action.

import { type MoveSize, moveSize, moveSizeText } from "../shared/move.ts";
import { type PrHealth, prHealth, prSummary } from "../shared/prs.ts";
import { isAnchor, laneOf, moveToLane } from "./model.ts";
import { isReady, moveOf } from "./status.ts";

// --- Card chips (issue #48) ------------------------------------------------------------

export type ChipId = "size" | "pr" | "br" | "port";

/** The PR chip: its number and its state words, each inked its own way. */
export interface PrChip {
  id: "pr";
  /** The number, "#135", drawn in the chip's own ink. */
  tag: string;
  /** The state words after the number ("draft", "1 failing"), in its health's ink; "" with none. */
  state: string;
  health: PrHealth;
  /** The diff size, "+120 −8", in faint ink after the state; "" with none. */
  diff: string;
  url?: string;
}

/** Every other chip: one line of words. */
export interface TextChip {
  id: Exclude<ChipId, "pr">;
  text: string;
  url?: string;
  /** The branch chip's uncommitted-changes dot. */
  dirty?: boolean;
  /** The size chip's size, which picks its ink. */
  size?: MoveSize;
}

export type Chip = PrChip | TextChip;

const isPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536;

function portChip(ports: readonly number[] | undefined): TextChip | null {
  const list = [...new Set((ports ?? []).filter(isPort))];
  const [first] = list;
  if (first === undefined) return null;
  const more = list.length > 1 ? " +" + (list.length - 1) : "";
  return { id: "port", text: ":" + first + more + " ↗", url: "http://localhost:" + first };
}

/** A card's chips, in order: the PR, the branch (when asked for), the ports. */
export function chipsFor(w: Workspace | undefined, withBranch: boolean): Chip[] {
  const out: Chip[] = [];
  if (!w) return out;
  // First, so what answering takes reads before where the work is.
  const move = moveOf(w);
  const size = move ? moveSize(move) : null;
  if (move && size) out.push({ id: "size", text: moveSizeText(size, move.decisions), size });
  const pr = prSummary(w);
  if (pr) {
    const c: PrChip = { id: "pr", tag: pr.tag, state: pr.state, health: pr.health, diff: pr.diff };
    if (pr.url) c.url = pr.url;
    out.push(c);
  }
  if (withBranch && w.branch) out.push({ id: "br", text: w.branch, dirty: !!w.dirty });
  const port = portChip(w.ports);
  if (port) out.push(port);
  return out;
}

// Ready cards (issue #53).

/** Its PR is ready to merge (the green chip), so "To review" shows in green. */
export const reviewIsGreen = (w: Workspace | undefined): boolean => prHealth(w) === "ready";

/**
 * A Ready card, or one whose PR is ready to merge, offers "To review",
 * unless it is already in For review or anchors a group: a generated lane
 * anchor is its group, and a real workspace anchoring one cannot leave it
 * (drop.ts pins those too). A ready PR never files the card itself, so
 * this is the way in.
 */
export function canFileForReview(w: Workspace | undefined): boolean {
  return !!w && (isReady(w) || reviewIsGreen(w)) && laneOf(w) !== "review" && !isAnchor(w);
}

/** Files a card into For review. */
export const fileForReview = (w: Workspace | undefined): void => moveToLane(w, "review");
