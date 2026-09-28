// Types for the cmux custom-sidebar renderer: the globals it hands a sidebar
// script, and the live data it exposes. There is no published schema, so the
// data shapes are what the sidebars read, and every field the app may leave
// out is optional (issue #7 lists what the data does not carry).

/** A value the renderer reads once, or re-reads whenever its signals change. */
type Reactive<T> = T | (() => T);

type Weight = "regular" | "medium" | "semibold" | "bold";
type Truncation = "head" | "middle" | "tail";
type Alignment = "leading" | "center" | "trailing" | "top" | "bottom";

interface FrameOptions {
  width?: Reactive<number>;
  height?: Reactive<number>;
  maxWidth?: Reactive<number | "infinity">;
  minHeight?: Reactive<number>;
  maxHeight?: Reactive<number | "infinity">;
  /** Honoured with maxWidth, but a fixed width centres its content regardless:
   * nest a maxWidth frame inside to place it. */
  alignment?: Alignment;
}

/** A node in the view tree. Every modifier returns a new node, so they chain. */
interface View {
  font(size: Reactive<number>): View;
  weight(weight: Reactive<Weight>): View;
  bold(): View;
  monospaced(): View;
  color(color: Reactive<string>): View;
  lineLimit(lines: number): View;
  truncation(mode: Truncation): View;
  layoutPriority(priority: number): View;
  padding(points: Reactive<number>): View;
  paddingHorizontal(points: Reactive<number>): View;
  paddingVertical(points: Reactive<number>): View;
  paddingTop(points: Reactive<number>): View;
  paddingBottom(points: Reactive<number>): View;
  paddingLeading(points: Reactive<number>): View;
  paddingTrailing(points: Reactive<number>): View;
  background(color: Reactive<string>): View;
  hoverBackground(color: Reactive<string>): View;
  cornerRadius(radius: Reactive<number>): View;
  frame(options: FrameOptions): View;
  fill(color: Reactive<string>): View;
  stroke(color: Reactive<string>): View;
  strokeWidth(width: number): View;
  rotation(degrees: Reactive<number>): View;
  opacity(value: Reactive<number>): View;
  value(fraction: Reactive<number>): View;
  /** Pins a row in a Reorderable so it cannot be dragged. */
  fixed(): View;
  onTap(action: () => void): View;
  contextMenu(items: MenuItem[]): View;
}

interface StackOptions {
  spacing?: number;
  alignment?: Alignment;
}

declare const menuItemBrand: unique symbol;
interface MenuItem {
  readonly [menuItemBrand]: true;
}

/** Items are re-keyed each render; `render` gets an accessor for its item. */
interface ForEachOptions<T> {
  items: () => readonly T[];
  key: (item: T) => string;
}

interface DragState {
  id: string;
  index: number;
}

interface ReorderableOptions<T> extends ForEachOptions<T> {
  spacing?: number;
  onMove: (key: string, index: number) => void;
  onDragChange: (drag: DragState | null) => void;
}

declare function VStack(options: StackOptions, children: View[]): View;
declare function HStack(options: StackOptions, children: View[]): View;
declare function ZStack(options: StackOptions, children: View[]): View;
declare function Text(content: Reactive<string>): View;
declare function Image(systemName: Reactive<string>): View;
declare function Spacer(options?: { minLength?: number }): View;
declare function Circle(options?: { size?: number }): View;
declare function Rectangle(): View;
declare function RoundedRectangle(options: { cornerRadius: number }): View;
declare function ProgressView(): View;
declare function ForEach<T>(options: ForEachOptions<T>, render: (item: () => T) => View): View;
declare function Reorderable<T>(options: ReorderableOptions<T>, render: (item: () => T) => View): View;

declare function Button(label: Reactive<string>, action: () => void): MenuItem;
// No Menu(): cmux drops submenus from a context menu without an error, so
// leaving it undeclared makes the compiler refuse one (PR #26).
declare function Divider(): MenuItem;

/** Author state local to this sidebar: a getter and a setter. */
declare function signal<T>(initial: T): [() => T, (next: T) => void];
declare function computed<T>(fn: () => T): () => T;

declare function sidebar(root: () => View, options?: { surface?: "glass" }): void;
/** Dispatches a cmux socket command, e.g. workspace.select. */
declare function cmux(method: string, params: Record<string, string | number | boolean>): void;
declare function openURL(url: string): void;

type AgentStatus = "needs_input" | "working" | "idle" | "ended";
type PrStatus = "open" | "merged" | "closed";

/** A subagent run nested under an agent session, e.g. a Task tool subagent.
 * cmux prunes settled runs after a short retention. */
interface SubagentRun {
  /** Stable for the run's lifetime. */
  id?: string;
  label?: string;
  running?: boolean;
  /** Epoch seconds the run started. */
  startedEpoch?: number;
  /** Epoch seconds the run settled. */
  endedEpoch?: number;
}

interface Agent {
  id: string;
  status: AgentStatus;
  name?: string;
  kind?: string;
  title?: string;
  surfaceId?: string;
  /** Epoch seconds the current status began. */
  sinceEpoch?: number;
  /** Epoch seconds of the agent's latest activity. */
  lastActivityAt?: number;
  /** Subagent runs under this session, oldest first; omitted when none. */
  children?: SubagentRun[];
}

interface PullRequest {
  url?: string;
  number?: number;
  status?: PrStatus;
  /** Only the saved PR carries it (scripts/pr-poll.ts); cmux sends none. */
  draft?: boolean;
  /** GitHub's own merge verdict ("CLEAN"); only the saved PR carries it. */
  mergeable?: boolean;
  /** GitHub says it has merge conflicts ("DIRTY"); only the saved PR carries it. */
  conflicts?: boolean;
  /** The PR's own title; only the saved PR carries it. */
  title?: string;
  label?: string;
  branch?: string;
  stale?: boolean;
}

interface Workspace {
  id: string;
  title?: string;
  directory?: string;
  selected?: boolean;
  pinned?: boolean;
  unread?: number;
  /** The workspace group's id, when it is in one. */
  group?: string | null;
  branch?: string;
  dirty?: boolean;
  latestMessage?: string;
  latestPrompt?: string;
  description?: string;
  latestAt?: number;
  agents?: Agent[];
  pr?: PullRequest | null;
  prs?: PullRequest[];
  progress?: { value?: number; label?: string } | null;
  ports?: number[];
}

interface WorkspaceGroup {
  id: string;
  name: string;
  anchorId?: string;
  collapsed?: boolean;
}

declare const data: {
  workspaces(): Workspace[] | null | undefined;
  groups(): WorkspaceGroup[] | null | undefined;
  clock(): { epoch: number } | null | undefined;
  selectedId(): string | null | undefined;
};
