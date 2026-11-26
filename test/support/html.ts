// A recorded view tree as an HTML page, for npm run preview.
//
// An approximation of the renderer's SwiftUI layout in flexbox, close enough
// to judge a design by: stacks are flex rows and columns, and each layout
// modifier wraps what came before it. Text styles are CSS that the children
// inherit. Colours print as their real hex. A modifier or view this file
// does not know is outlined dashed on the page and listed in `unknown`, so
// a scene that renders cleanly here has nothing silently dropped.
//
// The wrapping follows cmux's model, not the chain order. cmux keeps a
// node's modifiers as props in one dictionary and applies them in a fixed
// order (CmuxSwiftRenderUI, SceneNodeView.swift, read at cmux commit
// 12023d89f): text styles, padding, background, corner radius, frame, then
// opacity. So a background hugs the content even when a frame was chained
// before it, a maxWidth frame is always leading-aligned, and a second call
// of a modifier on one node replaces the first (frames merge key by key).
// If cmux changes that file, change this model and its tests with it.

import type { ViewNode } from "./renderer.ts";

type Axis = "row" | "col" | "z";

interface Built {
  html: string;
  /** Expands to its parent's width, as a maxWidth: infinity frame does. */
  fillW: boolean;
  /** Expands to its parent's height: a bare shape. */
  fillH: boolean;
}

/** One rendered page and every name it could not draw. */
export interface Page {
  html: string;
  unknown: string[];
}

type Opts = Record<string, unknown>;

// Modifiers that change nothing a still picture shows.
const INERT = new Set(["onTap", "contextMenu", "hoverBackground", "fixed", "hideOnHover", "value", "cursor"]);

// SF Symbols have no web font: a glyph near enough in shape and weight. A
// project's icon can be any symbol, so a name not here draws as a diamond
// rather than counting as unknown.
const SYMBOLS: Record<string, string> = {
  "arrow.branch": "⑂",
  "arrow.up": "↑",
  terminal: "▭",
  "star.fill": "★",
  "pin.fill": "†",
  xmark: "✕",
  "checkmark.circle": "✓",
  "xmark.circle": "✕",
  clock: "◷",
  "minus.circle": "⊖",
  "doc.text": "▤",
  macwindow: "▢",
  "bell.fill": "🔔︎",
  "chevron.right": "›",
  "cube.fill": "■",
  plus: "+",
  "leaf.fill": "❦",
  "arrow.triangle.pull": "⇅",
  "bolt.fill": "ϟ",
  "book.fill": "▮",
  "flame.fill": "♨︎",
  "folder.fill": "▰",
  "gearshape.fill": "⚙︎",
  "hammer.fill": "⚒︎",
  "music.note": "♪",
  "paintbrush.fill": "✎",
  airplane: "✈︎",
  "chevron.left.forwardslash.chevron.right": "‹/›",
  "terminal.fill": "▬",
  "house.fill": "⌂",
  "bag.fill": "◘",
};

const ALIGN: Record<string, string> = {
  leading: "flex-start",
  top: "flex-start",
  center: "center",
  trailing: "flex-end",
  bottom: "flex-end",
};

const WEIGHT: Record<string, number> = { regular: 400, medium: 500, semibold: 600, bold: 700 };

const html = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const colour = (v: unknown): string => (typeof v === "string" && v !== "clear" ? v : "transparent");

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const pad = (v: unknown): number => num(v) ?? 16;

// The recorder resolves an options argument to a plain object of its fields,
// so an object that is not an array is one.
const opts = (v: unknown): Opts => (v && typeof v === "object" && !Array.isArray(v) ? (v as Opts) : {});

const axisOf = (kind: string): Axis => (kind === "VStack" ? "col" : kind === "HStack" ? "row" : "z");

// A stack's or list's spacing. CSS ignores a negative gap, so a negative one
// is a zero gap and group() pulls each child after the first back instead.
const gapCss = (spacing: number): string => `gap:${Math.max(spacing, 0)}px`;

// The margin that overlaps a child with the one before it along the axis.
const overlap = (axis: Axis, spacing: number): string =>
  spacing < 0 && axis !== "z" ? `${axis === "row" ? "margin-left" : "margin-top"}:${spacing}px` : "";

const leaf = (markup: string, fill = false): Built => ({ html: markup, fillW: fill, fillH: fill });

// Modifiers that style the element built so far, as CSS its children inherit.
const STYLE: Record<string, (v: unknown) => string> = {
  font: (v) => `font-size:calc(${num(v) ?? 13}px * var(--fs))`,
  weight: (v) => `font-weight:${WEIGHT[String(v)] ?? 400}`,
  bold: () => "font-weight:700",
  monospaced: () => "font-family:var(--mono)",
  color: (v) => `color:${colour(v)}`,
  lineLimit: (v) =>
    num(v) === 1
      ? "white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
      : `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${num(v) ?? 1};overflow:hidden`,
  truncation: (v) => (v === "head" ? "direction:rtl;text-align:left" : ""),
  // SwiftUI gives space to the higher priority first; here the lower one shrinks first.
  layoutPriority: (v) => `flex-shrink:${10 ** -(num(v) ?? 0)}`,
  stroke: (v) => `--stroke:${colour(v)};box-shadow:inset 0 0 0 var(--sw,1px) var(--stroke)`,
  strokeWidth: (v) => `--sw:${num(v) ?? 1}px`,
  opacity: (v) => `opacity:${num(v) ?? 1}`,
  // Hidden until hovered unless its flag reads false. The recorder resolves a
  // reactive flag already; a function here is read once all the same.
  showOnHover: (v) => ((typeof v === "function" ? v() : v) === false ? "" : "opacity:0"),
};

// Modifiers that wrap the element built so far in a new one.
const WRAP: Record<string, (v: unknown) => string> = {
  padding: (v) => `padding:${pad(v)}px`,
  paddingHorizontal: (v) => `padding-left:${pad(v)}px;padding-right:${pad(v)}px`,
  paddingVertical: (v) => `padding-top:${pad(v)}px;padding-bottom:${pad(v)}px`,
  paddingTop: (v) => `padding-top:${pad(v)}px`,
  paddingBottom: (v) => `padding-bottom:${pad(v)}px`,
  paddingLeading: (v) => `padding-left:${pad(v)}px`,
  background: (v) => `background:${colour(v)}`,
  cornerRadius: (v) => `border-radius:${num(v) ?? 0}px;overflow:hidden`,
};

interface Frame {
  css: string;
  fillW?: boolean;
  fillH?: boolean;
}

// A frame as cmux draws it: two SwiftUI frames. The inner one holds the
// flexible keys (maxWidth: infinity expands it, maxHeight, minHeight) and
// always places its content leading, whatever alignment the code asks for.
// The outer one holds a fixed width or height, which stops expanding and
// centres what is inside it.
function frames(f: Opts): Frame[] {
  const flex: string[] = [];
  const inner: Frame = { css: "" };
  if (num(f.minHeight) !== undefined) flex.push(`min-height:${num(f.minHeight)}px;justify-content:center`);
  if (num(f.maxHeight) !== undefined) flex.push(`max-height:${num(f.maxHeight)}px;overflow:hidden`);
  if (f.maxHeight === "infinity") inner.fillH = true;
  if (num(f.maxWidth) !== undefined) flex.push(`max-width:${num(f.maxWidth)}px`);
  if (f.maxWidth === "infinity") inner.fillW = true;
  const hasInner = ["minHeight", "maxHeight", "maxWidth"].some((k) => f[k] !== undefined);
  inner.css = ["align-items:flex-start", ...flex].join(";");
  const fixed: string[] = [];
  const outer: Frame = { css: "" };
  const width = num(f.width);
  const height = num(f.height);
  if (width !== undefined) {
    fixed.push(`width:${width}px;flex-shrink:0;align-items:center`);
    outer.fillW = false;
  }
  if (height !== undefined) {
    fixed.push(`height:${height}px;flex-shrink:0;justify-content:center`);
    outer.fillH = false;
  }
  outer.css = fixed.join(";");
  return [...(hasInner ? [inner] : []), ...(fixed.length ? [outer] : [])];
}

// Puts `css` into the style of the outermost tag of `markup`.
function styled(markup: string, css: string): string {
  if (!css) return markup;
  return markup.replace(/^<div class="([^"]*)"(?: style="([^"]*)")?/, (_m, cls: string, st: string | undefined) => {
    return `<div class="${cls}" style="${[st, css].filter(Boolean).join(";")}"`;
  });
}

// Adds the expansion classes to the outermost tag of `b`.
function classed(b: Built): string {
  const extra = [b.fillW ? "fw" : "", b.fillH ? "fh" : ""].filter(Boolean).join(" ");
  if (!extra) return b.html;
  return b.html.replace(/^<div class="([^"]*)"/, (_m, cls: string) => `<div class="${cls} ${extra}"`);
}

class Writer {
  readonly unknown = new Set<string>();

  node(n: ViewNode, parent: Axis, gap: number): string {
    return classed(this.modify(n, this.core(n, parent, gap)));
  }

  // The view itself, before any modifier.
  private core(n: ViewNode, parent: Axis, gap: number): Built {
    const o = opts(n.args[0]);
    switch (n.kind) {
      case "VStack":
      case "HStack":
      case "ZStack":
        return this.stack(n, axisOf(n.kind), o);
      case "ForEach":
      case "Reorderable":
        return this.list(n, parent, gap, o);
      case "Text":
        return leaf(`<div class="t">${html(typeof n.args[0] === "string" ? n.args[0] : "")}</div>`);
      case "Image":
        return this.image(typeof n.args[0] === "string" ? n.args[0] : "");
      case "ProgressView":
        return progress(n);
      case "Spacer":
        return spacer(parent, num(o.minLength) ?? 8);
      default:
        return this.shape(n.kind, o);
    }
  }

  private image(name: string): Built {
    return leaf(`<div class="i">${SYMBOLS[name] ?? "◆"}</div>`);
  }

  private shape(kind: string, o: Opts): Built {
    const size = num(o.size);
    if (kind === "Circle" && size !== undefined)
      return leaf(`<div class="shape dot" style="width:${size}px;height:${size}px"></div>`);
    if (kind === "Circle") return leaf(`<div class="shape" style="border-radius:50%"></div>`, true);
    if (kind === "Rectangle") return leaf(`<div class="shape"></div>`, true);
    if (kind === "RoundedRectangle")
      return leaf(`<div class="shape" style="border-radius:${num(o.cornerRadius) ?? 0}px"></div>`, true);
    this.unknown.add(kind);
    return leaf(`<div class="x">${html(kind)}</div>`);
  }

  private stack(n: ViewNode, axis: Axis, o: Opts): Built {
    const spacing = num(o.spacing) ?? 8;
    const align = ALIGN[String(o.alignment)];
    const css = [axis === "z" ? "" : gapCss(spacing)];
    if (align) css.push(axis === "z" ? `place-items:${align}` : `align-items:${align}`);
    return this.group(n, axis, spacing, `<div class="${axis}" style="${css.filter(Boolean).join(";")}">`);
  }

  // A list lays its rows out in its parent's direction unless it carries a
  // spacing of its own (a Reorderable is a column), and is invisible
  // structure unless it has modifiers. An empty ForEach is always
  // invisible: SwiftUI applies its modifiers to its rows, so with no rows it
  // takes no slot in its stack's spacing (an unshown when() chip). A
  // Reorderable is a stack of its own, so it keeps its slot.
  private list(n: ViewNode, parent: Axis, gap: number, o: Opts): Built {
    const own = num(o.spacing);
    const axis: Axis = own === undefined ? parent : "col";
    const spacing = own ?? gap;
    const open =
      (n.kind === "ForEach" && !n.children.length) || (!n.mods.length && own === undefined)
        ? `<div class="contents">`
        : `<div class="${axis}" style="${gapCss(spacing)}">`;
    return this.group(n, axis, spacing, open);
  }

  // SwiftUI's stacks take the flexibility of their children.
  private group(n: ViewNode, axis: Axis, spacing: number, open: string): Built {
    const pull = overlap(axis, spacing);
    const kids = n.children.map((c, i) => {
      const kid = this.node(c, axis, spacing);
      return i > 0 ? styled(kid, pull) : kid;
    });
    const fillW = kids.some((k) => /^<div class="[^"]*\bfw\b/.test(k));
    const fillH = kids.some((k) => /^<div class="[^"]*\bfh\b/.test(k));
    return { html: `${open}${kids.join("")}</div>`, fillW, fillH };
  }

  // A styling modifier's CSS; one this file does not know is outlined.
  private style(name: string, v: unknown): string {
    const css = STYLE[name];
    if (css) return css(v);
    if (INERT.has(name)) return "";
    this.unknown.add(`.${name}`);
    return "outline:1px dashed #d00";
  }

  // A node's modifiers as cmux applies them: styles on the view itself,
  // then each layout modifier in the fixed order, then the outer styles.
  // A shape's fill paints the shape itself, keeping its corner radius.
  private modify(n: ViewNode, core: Built): Built {
    const shape = core.html.startsWith('<div class="shape');
    const p = props(n.mods, shape);
    const inner = [...p.fills, ...p.styles.map(([name, v]) => this.style(name, v))];
    let b: Built = { ...core, html: styled(core.html, inner.filter(Boolean).join(";")) };
    for (const [name, v] of p.layout) b = wrapIn(b, name, v);
    const outer = p.outer.map(([name, v]) => this.style(name, v));
    return { ...b, html: styled(b.html, outer.filter(Boolean).join(";")) };
  }
}

type Prop = [name: string, value: unknown];

// Layout modifiers in the order cmux applies them; a padding of each kind
// is its own prop.
const LAYOUT = [
  "padding",
  "paddingHorizontal",
  "paddingVertical",
  "paddingTop",
  "paddingBottom",
  "paddingLeading",
  "fill",
  "background",
  "cornerRadius",
  "frame",
];

// Styles cmux applies after the frame, so they act on the whole framed box.
const OUTER = new Set(["opacity", "showOnHover", "layoutPriority"]);

interface Props {
  fills: string[];
  styles: Prop[];
  layout: Prop[];
  outer: Prop[];
}

// A node's modifiers as one dictionary: a later call of the same modifier
// replaces the earlier one, except that frames merge key by key.
function props(mods: ViewNode["mods"], shape: boolean): Props {
  const last = new Map<string, unknown>();
  for (const m of mods) {
    const v = m.values[0];
    last.set(m.name, m.name === "frame" ? { ...opts(last.get("frame")), ...opts(v) } : v);
  }
  const all = [...last.entries()];
  const fill = shape && last.has("fill") ? [`background:${colour(last.get("fill"))}`] : [];
  const layout = LAYOUT.filter((name) => last.has(name) && !(shape && name === "fill")).map(
    (name): Prop => [name, last.get(name)],
  );
  return {
    fills: fill,
    styles: all.filter(([name]) => !LAYOUT.includes(name) && !OUTER.has(name)),
    layout,
    outer: all.filter(([name]) => OUTER.has(name)),
  };
}

// Wraps `b` in one layout modifier's element.
function wrapIn(b: Built, name: string, v: unknown): Built {
  if (name === "frame") {
    return frames(opts(v)).reduce<Built>(
      (box, f) => ({
        html: `<div class="w" style="${f.css}">${classed(box)}</div>`,
        fillW: f.fillW ?? box.fillW,
        fillH: f.fillH ?? box.fillH,
      }),
      b,
    );
  }
  const css = name === "fill" ? `background:${colour(v)}` : (WRAP[name]?.(v) ?? "");
  return { html: `<div class="w" style="${css}">${classed(b)}</div>`, fillW: b.fillW, fillH: b.fillH };
}

// With a value it is the system's linear bar, in the accent blue; without,
// the spinner.
function progress(n: ViewNode): Built {
  const value = num(n.mods.find((m) => m.name === "value")?.values[0]);
  if (value === undefined) return leaf(`<div class="pv"></div>`);
  return { html: `<div class="bar"><div style="width:${value * 100}%"></div></div>`, fillW: true, fillH: false };
}

function spacer(parent: Axis, min: number): Built {
  const dim = parent === "row" ? "min-width" : "min-height";
  return { html: `<div class="sp" style="${dim}:${min}px"></div>`, fillW: parent === "row", fillH: parent === "col" };
}

const CSS = `
:root{--mono:"SF Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;font:calc(13px * var(--fs))/1.2 -apple-system,"SF Pro Text",system-ui,sans-serif;color:#141413;-webkit-font-smoothing:antialiased}
#root{display:flex;flex-direction:column;align-items:flex-start}
.col,.row,.w{display:flex;min-width:0}
.col,.w{flex-direction:column}
.col{align-items:center}
.row{flex-direction:row;align-items:center}
.z{display:grid;place-items:center;min-width:0}
.z>*,.z>.contents>*{grid-area:1/1}
.contents{display:contents}
.col>*,.w>*,.col>.contents>*{max-width:100%}
.t{min-width:0}
.i{line-height:1;text-align:center}
.x{outline:1px dashed #d00}
.shape{flex:1 1 auto;align-self:stretch}
.shape.dot{flex:none;align-self:auto;border-radius:50%}
.bar{height:4px;border-radius:2px;background:#1414131A;overflow:hidden}
.bar>div{height:100%;background:#3D6FB8}
.pv{width:12px;height:12px;border-radius:50%;border:2px solid #0002;border-top-color:#0008}
.row>.fw,.row>.contents>.fw{flex:1 1 0;min-width:0}
.col>.fw,.w>.fw,.col>.contents>.fw,#root>.fw{align-self:stretch}
.z>.fw{justify-self:stretch}
.z>.fh{align-self:stretch}
.w>.fh,.col>.fh{flex:1 1 auto}
`;

/**
 * The tree under `root` as a standalone page `width` points wide on
 * `ground`, its text scaled by `fontScale` to match how wide cmux draws it. Once laid out, the page puts its content height in its title,
 * which is how the preview script sizes the screenshot.
 */
export function toPage(root: ViewNode, title: string, width: number, ground: string, fontScale = 1): Page {
  const w = new Writer();
  const body = w.node(root, "col", 0);
  const size = `addEventListener("load",()=>{document.title=String(document.getElementById("root").scrollHeight)})`;
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${html(title)}</title><style>${CSS}</style></head><body style="background:${ground};width:${width}px;--fs:${fontScale}"><div id="root">${body}</div><script>${size}</script></body></html>\n`;
  return { html: page, unknown: [...w.unknown].sort() };
}
