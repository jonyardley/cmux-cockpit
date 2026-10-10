# Native sidebar design reference

This describes the look of the native Mac left sidebar (`native/mac/Sidebar`,
SwiftUI) as it stands on main at `cc996b7`. It is the one reference for that
look. The TypeScript sidebars (`src/cockpit`, `src/agents`) and the terminal
pane (`native/pane`) are being retired, so nothing here describes them, and a
view comment that points at one of them (for example `(cards.ts fullCard)`)
should point at the matching heading here instead (`docs/design.md#full-card`).

Read it before changing a view, `Palette.swift` or `Theme.swift`, and update
it in the same PR when the look changes. Sections that describe a known
inconsistency say so and link to the [known gaps](#known-gaps).

File paths below are relative to `native/mac/Sidebar/` unless they say
otherwise. Line numbers are as of `cc996b7`.

## Principles

1. **Hue only ever means state.** Clay is your turn, amber is asking, blue is
   working, the olive green is finished, the vivid merge green is ready to
   merge, red is failing. Nothing decorative takes one of these hues.
2. **Neutral ink for everything else.** Selection, lanes, headings, counts and
   hover are drawn in the neutral inks and greys. A selected card's outline is
   the heading ink, not a hue.
3. **The unread badge is grey.** Unread is not a state that wants you, so it
   never borrows clay (`CardView.swift:315`).
4. **Every colour has a light and a dark side.** A colour is a pair in
   `Model/Palette.swift`; there is no colour that exists in one appearance only.
5. **Every colour comes from the palette.** A view draws with `Color(Token)`
   or `Color(Palette.Own)` (`Views/Theme.swift:7-13`). The one exception is a
   project's own colour from the user's table, `Color(project:)`
   (`Views/ProjectsView.swift:6`).
6. **Every size comes from a named constant.** Type sizes, spacing and radii
   live in `Metrics` (`Views/Theme.swift:31`) or a view's own look enum
   (`CardLook`, `ChipLook`, `ProjectMetrics`). Today a number of literals
   still sit in views: see [gap C](#known-gaps).

## Colour

`Model/Palette.swift` holds every colour literal in the extension. Core tokens
(`Token`, chosen by the Rust core in `native/core/src/theme.rs`) are mapped at
`Palette.swift:103-148`; the colours only the views need (`Palette.Own`) are at
`Palette.swift:150-169`. An alpha after the hex is written as `/ 0xAA`; a
"faint" token is its hue at that alpha, drawn over whatever is under it.

### The ground

The panel sits on `Own.panelGround`, **FAF9F5** light: cmux's own window
off-white, sampled from a light capture (`Palette.swift:34-38`, `:153`). It is
not the old TS sidebar's F4F2EA, which survives only as `Own.ground`. Dark is
262624 and was not sampled (see [gap L](#known-gaps)).

### State hues

| Token | Light | Dark | Means | Where drawn |
|-|-|-|-|-|
| `clay` | D97757 | E08A6D | your turn | the waiting count on the All tab (`TopView.swift:79`); a needs dot |
| `amber` | D9A03F | E3B260 | asking | needs dot, status dot (core picks) |
| `blue` | 3B6FB6 | 6A9BE0 | working | progress bar fill (`CardView.swift:438`), status dot |
| `green` | 788C5D | 93A877 | finished | status dot (core picks) |
| `mergeGreen` | 1DB954 | 3DD171 | ready to merge | status dot (core picks) |
| `greenDeep` | 3F5A2B | A6C58A | a PR GitHub would merge | lane header merge line (`LaneView.swift:165`) |
| `clayHalo` | clay / 0x38 | same | soft ring round a clay dot | status dot halo |
| `amberHalo` | amber / 0x38 | same | soft ring round an amber dot | status dot halo; also the helper-down banner (`PanelView.swift:106`, [gap J](#known-gaps)) |
| `blueHalo` | blue / 0x2E | same | soft ring round a blue dot | status dot halo |
| `mergeHalo` | mergeGreen / 0x47 | same | soft ring round a merge dot | status dot halo |

### State inks (words in a state)

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `clayText` | A34A2A | E8997C | Next's line (`TopView.swift:100`); status words; "Not sent" ([gap J](#known-gaps)) |
| `amberText` | 8A5A0B | E8BC6E | status words (core picks) |
| `blueText` | 2F5690 | 8FB4EC | status words (core picks) |
| `greenText` | 5E7A40 | A3BC85 | the Ready pill (`CardView.swift:306`) |
| `mergeText` | 12873B | 5FD98A | "Ready to merge" in words |
| `redText` | 9E2F27 | E3796F | a failing PR; editor problems and Remove (`EditorSheet.swift:55`, `:59`) |

### Neutral inks

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `text` | 141413 | F0EEE6 | card titles, the chosen tab, notice titles |
| `heading` (also `select`, `laneMain`) | 3D3D3A | D6D4CA | project header names, a selected card's outline, "Drop here" |
| `secondary` (also `laneReview`) | 5E5D59 | B7B5A9 | lane names, detail lines, chip glyphs, the tab not chosen |
| `metaText` | 6B6A64 | A3A199 | Next's place, a dense row's age |
| `faint` (also `laneBackground`) | 8A8880 | 8A8880 | fold chevron, pin, QUIET, editor labels ([gap L](#known-gaps)) |
| `Own.tertiary` | 73726C | 9C9A92 | where you left off, live helpers, a title row's age |
| `Own.grey` | A09E95 | 77756D | a dot with no colour; a project with no colour |

### Surfaces and edges

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `Own.panelGround` | FAF9F5 | 262624 | under the whole panel (`PanelView.swift:113`), under a floating card |
| `Own.card` | FFFFFF | 30302D | a card's face, the chosen tab, Next's pill, an action chip |
| `Own.cardHover` | F7F6F2 | 383835 | a card's face under the pointer |
| `Own.hover` | 7F7F7F / 0x14 | 7F7F7F / 0x24 | a header, tab, chip or quiet row under the pointer |
| `cardEdge` | text / 0x1F | same | a card's hairline, the chosen tab's edge, the dismiss x ring |
| `chipFace` | F1EFE8 | 30302D | a quiet chip's face |
| `chipEdge` | E2DFD3 | 484741 | a chip's edge, the view switch track's edge |
| `countBg` | E5E2D6 | 3A3935 | the switch track, progress bar track, chosen editor icon |
| `Own.needsEdge` | F0D2C3 | clay / 0x47 | Next's pill edge |
| `Own.needsHover` | FBF1EB | 3A3330 | Next's pill under the pointer |
| `Own.readyBg` | green / 0x1F | same | the Ready pill's face |
| `Own.dropTarget` | text / 0x1F | same | a lane header while a card is dragged over it |
| `Own.zoneLit` | E7E4D9 | 3A3935 | an empty lane's drop zone while a card is over it |
| `Own.anchorSelected` | text / 0x1F | same | an anchor badge while its workspace is selected |
| `Own.lift` | 000000 / 0x2E | 000000 / 0x66 | the shadow under a dragged card |

### Counts, chips and badges

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `Own.badge` | = `secondary` | = `secondary` | the unread badge's face |
| `Own.onBadge` | FFFFFF | 1F1E1D | the unread badge's number |
| `Own.onFill` | FFFFFF | FFFFFF | the number on the clay waiting count |
| `blueCount`, `clayCount`, `amberCount` | hue / 0x1F, 0x29, 0x29 | same | a count pill's face in a state (core picks) |
| `redChipFace`, `redChipEdge` | red / 0x1A, 0x38 | same | a failing PR chip |
| `blueChipFace`, `blueChipEdge` | blue / 0x1A, 0x38 | same | a PR chip in review |
| `greenChipFace`, `greenChipEdge` | green / 0x29, greenDeep / 0x59 | same | a PR chip ready |

### Lanes

| Token | Light | Dark | Lane |
|-|-|-|-|
| `laneMain` | 3D3D3A | D6D4CA | the main lane marker |
| `laneReview` | 5E5D59 | B7B5A9 | review |
| `laneBackground` | 8A8880 | 8A8880 | background |
| `laneParked` | B0AEA5 | 6E6C66 | parked |
| `laneUnsorted` | C9C6BB | 57564F | unsorted |
| `laneViolet`, `laneTeal`, `laneRose` | 7A5BA6, 2E8A86, B04A75 | B39BD6, 6CC2BC, E08AAE | the three hues `config/lanes.json` may pick, clear of the state hues |

### Not drawn by any view

`Own.ground` and `Own.cardFace` are read only by the views test; `amberRowEdge`
and `needsRowEdge` are neither chosen by the core nor drawn. See
[gap F](#known-gaps).

## Type scale

Every type size is a named constant; no view passes a bare number to
`.font(.system(size:))`. Eleven distinct sizes are in use once glyphs are
counted. Weights are named beside each use.

| Size | Names | What draws with it |
|-|-|-|
| 13.5 | `Metrics.Font.cardTitle` | a full card's title, semibold |
| 13 | `Metrics.Font.compactTitle` | a compact card's title, semibold |
| 12.5 | `Metrics.Font.title`, `CardLook.rowTitle` | project header name (semibold), quiet row and New project label (regular), a dense row's title (regular, medium when selected), a Projects card's title (semibold) |
| 12 | `Metrics.Font.control`, `Metrics.body`, `CardLook.fullBadgeFont` | the view switch's tabs (medium), a full or Projects card's status (medium), detail, left off, notices, the editor and Message agent (body); a full card's badge glyph |
| 11.5 | `Metrics.Font.next`, `CardLook.compactStatus` | Next's line (semibold), a compact card's status (regular) |
| 11 | `Metrics.Font.meta`, `Metrics.small`, `CardLook.compactBadgeFont`, `ProjectMetrics.plusFont` | ages, count pills (medium, digits monospaced), chip words, a lane header row; editor labels and notes, "Not sent", the project header row; a compact badge glyph; the header "+" |
| 10.5 | `Metrics.Font.section` | section headings in tracked capitals (semibold); the Ready pill (medium) |
| 10 | `Metrics.Font.tiny`, `ProjectMetrics.headerBadgeFont`, `ProjectMetrics.rowPlusFont` | fold chevron, unread badge, waiting count (bold); project header badge glyph; quiet row "+" |
| 9.5 | `CardLook.pin` | the pin |
| 9 | `ChipLook.glyph`, `ProjectMetrics.quietBadgeFont` | PR and branch glyphs in a chip; a quiet project's badge glyph |
| 8 | `CardLook.rowBadgeFont`, `Metrics.dismissGlyph` | a dense row's badge glyph; the dismiss x (bold) |

The `Metrics.Font` enum (`Views/Theme.swift:51-68`) is the reading scale and
covers 10 to 13.5. `Metrics.body` and `Metrics.small` (`Theme.swift:32-33`)
are a second set of names for 12 and 11. See [gap B](#known-gaps).

Section headings are tracked by `Metrics.sectionTracking` (1pt,
`Theme.swift:115`) and set in capitals by `.textCase(.uppercase)`, never by
capitalising the string.

## Spacing and radii

### Spacing (`Views/Theme.swift`)

| Name | Value | Use |
|-|-|-|
| `Metrics.gutter` | 10 | the panel's padding all round (`PanelView.swift:52`) and a notice's |
| `Metrics.cardGap` | 6 | between cards in a lane (`LaneView.swift:200`) |
| `Metrics.sectionGap` | 14 | from the section above to a header's words |
| `Metrics.headerPadH`, `headerPadV` | 8, 5 | inside a lane or project header |
| `Metrics.headerSpacing` | 8 | between the parts of a header row |
| `Metrics.pillPadH`, `pillPadV` | 7, 1 | inside a count pill and the waiting count |
| `Metrics.switchHeight`, `switchInset` | 26, 3 | a tab's height; the track's inner padding |
| `Metrics.hairline` | 1 | every edge |
| `Metrics.chevronWidth`, `chevronHeight` | 12, 16 | the fold chevron's slot, so names line up |
| `Metrics.laneMarker`, `headerDot` | 9, 7 | a lane's square marker; a header's dot |
| `Metrics.dismissSize` | 16 | the dismiss x's circle |
| `Metrics.needsDotShare`, `needsDotRing` | 0.36, 2 | a needs dot as a share of its badge, and its ring |
| `Metrics.emptyFade` | 0.55 | an empty lane's marker and count |

### Card spacing (`CardLook`, `Views/CardView.swift:9-48`)

| Name | Value | Use |
|-|-|-|
| `padLeading`, `padTrailing`, `padV` | 10, 12, 11 | inside a full or compact card |
| `fullGap`, `compactGap` | 10, 9 | badge to text |
| `rowPadLeading`, `rowPadV` | 25, 5 | inside a dense row, so its dot sits under the lane marker |
| `rowIndent` | 7 + 6 + 6 + 14 + 6 | a dense row's second line starts under its title |
| `projectPad`, `projectGap` | 10, 5 | inside a Projects card; above its chips and bar |
| `bar` | 4 | the progress bar's height |
| `dimmed` | 0.6 | a merged card nothing in it wants |

### Chips (`ChipLook`, `Views/ChipsView.swift:6-18`)

`padH` 6, `padV` 1, `inner` 4 (glyph to words), `dirty` 5 (the dot), `gap` 5
between chips, `lineGap` 4 between chip lines.

### Projects view (`ProjectMetrics`, `Views/ProjectsView.swift:37-58`)

Header badge 18, quiet badge 16, "+" button 20, row padding 3, row radius 7,
Quiet heading padding 4, gap above Quiet 10, gap above New project 6.

### Radii (`Metrics.Radius`, `Views/Theme.swift:71-88`)

| Name | Value | Use |
|-|-|-|
| `card` | 12 | full and compact cards |
| `row` | 9 | a dense row, a Projects card |
| `track` | 10 | the view switch's track |
| `pill` | 10 | a count pill |
| `header` | 8 | a lane or project header, the Quiet heading, an empty lane's zone |
| `tab` | 7 | a switch tab, Next's pill, the unread badge |
| `anchor` | 6 | an anchor badge's face |
| `chip` | 6 | every chip |

Badge tiles carry their own radius: 26 takes 8, 22 takes 7, 18 and 16 take
the default 5, 14 takes 4. Each is `round(0.3 × size)`; the lane marker's
`size / 3` lands on the same 3. See [gap D](#known-gaps).

## Components

### View switch

Two tabs, All and Projects, on a rounded track. The chosen tab is a solid
card face with a hairline edge and words in the first ink; the other is
transparent with words in the second ink and lights grey under the pointer.
While something waits, All carries the [waiting count](#needs-count).

Track: `countBg` face, `chipEdge` hairline, radius `Radius.track` 10, inner
padding `switchInset` 3. Tab: height 26, radius `Radius.tab` 7, `Own.card`
face and `cardEdge` edge when chosen. Words: `Font.control` 12 medium. The
switch sits 14 in from the sidebar edge (`PanelView.swift:63`).
Where: `Views/TopView.swift:8-59`.

### Needs count

White number on a clay capsule on the All tab; a click steps to the next
waiting card. `Font.tiny` 10 bold, monospaced; padding `pillPadH` 7 and
`pillPadV` 1; `clay` face, `Own.onFill` ink; capsule shape.
Where: `Views/TopView.swift:65-84`. See [gap A](#known-gaps).

### Next

A white pill with a clay edge, "Next: <title>" in clay cut in the middle, the
place in the queue on the right. Shown only while nothing waits. Face
`Own.card`, `Own.needsHover` under the pointer; edge `Own.needsEdge`; radius
`Radius.tab` 7; padding 8 by 5 (literals, [gap C](#known-gaps)). Title
`Font.next` 11.5 semibold `clayText`; place `Font.meta` 11 monospaced
`metaText`. Where: `Views/TopView.swift:91-120`.

### Lane header

Fold chevron, the lane's square marker, the name in tracked capitals, an
anchor badge if the lane has one, the count pill, the folded lane's dot, and
on the right the merge line ("2 ready to merge") or "Drop here" during a drag.
Lights grey under the pointer, and with `Own.dropTarget` while a card is over
it. An empty lane draws as a drop zone: no chevron, marker and count at
`emptyFade` 0.55, and while a card is over it an `Own.zoneLit` face with a
`heading` hairline.

Padding `headerPadH` 8, `headerPadV` 5; radius `Radius.header` 8; spacing
`headerSpacing` 8; gap above `sectionGap` 14 less the vertical padding. Name
`Font.section` 10.5 semibold, `secondary` (or `faint` for a faint lane). Row
size `Font.meta` 11. Where: `Views/LaneView.swift:104-178`.

### Fold chevron

`chevron.right` at `Font.tiny` 10 semibold in `faint`, turned down when open,
in a 12 by 16 slot. Where: `Views/LaneView.swift:22-32`.

### Lane marker

A rounded square in the lane's colour, 9 square, radius a third of its size.
Where: `Views/LaneView.swift:35-44`.

### Anchor badge

On a lane header, a lane's generated workspace with no card: its status glyph
and unread count, a click opens it. Face clear, `Own.hover` under the
pointer, `Own.anchorSelected` while selected; radius `Radius.anchor` 6; height
16; padding 4. The unread count inside is an inline copy of the
[unread badge](#unread-badge). Where: `Views/LaneView.swift:63-95`.

### Project header

Fold chevron, the project's [badge tile](#badge-tile) at 18 with a 10 glyph,
the name, the count pill, the folded project's dot, and a round "+" when the
project has a folder. Name `Font.title` 12.5 semibold in `heading`. Padding,
radius and gap as the lane header; hover through the shared hover shade.
Where: `Views/ProjectsView.swift:106-134`. The row's own size is
`Metrics.small` where the lane header uses `Font.meta` (same 11, different
name, [gap B](#known-gaps)).

### Plus button

A 20 circle with `plus` at 11 semibold in `secondary`, grey under the
pointer. Where: `Views/ProjectsView.swift:83-99`.

### Quiet header

Fold chevron, QUIET in tracked capitals in `faint`, the count pill. Padding
8 by 4, radius 8, 10 above it. Where: `Views/ProjectsView.swift:139-161`.

### Quiet row

A project with no sessions: 16 badge with a 9 glyph, name at `Font.title`
12.5 regular in `secondary`, and a faint "+" when it has a folder. A row with
no folder takes no click and fades to `ProjectText.quietFade` 0.55
(`Model/ProjectText.swift:47`). Padding 8 by 3, hover radius 7.
Where: `Views/ProjectsView.swift:167-213`.

### New project row

"+ New project" styled as a quiet row: a 10 semibold plus in the 16 badge
slot, the label in `secondary` at 12.5. Six above it.
Where: `Views/ProjectsView.swift:218-243`.

### Full card

The badge tile (26, glyph 12, radius 8) beside a column of: the title row, the
status line, the chips, the detail over up to two lines, the progress bar.
Badge to text 10; padding 10 leading, 12 trailing, 11 above and below; column
spacing 4 (literal). Title `Font.cardTitle` 13.5 semibold over two lines;
status `Font.control` 12 medium with a 7 dot. Radius `Radius.card` 12, with
the [card chrome](#card-chrome). Where: `Views/CardView.swift:66-90`.

### Compact card

A smaller badge (22, glyph 11, radius 7), the title on one line, the status
line with the PR in words and its diff faint after it, where you left off,
the detail, the progress bar. Badge to text 9; same padding as the full card;
column spacing 3 (literal). Title `Font.compactTitle` 13 semibold; status
`CardLook.compactStatus` 11.5 regular with a 6 dot. Radius 12.
Where: `Views/CardView.swift:95-120`.

### Dense row

One line: status dot (7), a 14 badge (glyph 8, radius 4), the title, its PR's
title faint after it, then unread, PR number, age, dismiss x, pin; under it
left off and the detail, indented to the title. No face until selected; grey
wash under the pointer. Title `CardLook.rowTitle` 12.5 regular (medium when
selected); age in `metaText`. Padding 25 leading, 12 trailing, 5 above and
below; radius `Radius.row` 9. Where: `Views/CardView.swift:126-170`.

### Projects card

The one shape every card takes in Projects. No badge (the header has it), so a
waiting card's needs dot leads its title. Title row at 12.5 semibold over two
lines, status line at 12 medium with a 7 dot, the detail, the chips (whose PR
opens on a click), the progress bar. Padding 10 all round; radius
`Radius.row` 9. Where: `Views/CardView.swift:176-193`.

### Title row

The title takes the slack; at its end the Ready pill, the unread badge, the
age (only when the status line has none), the dismiss x and the pin. Spacing
6. Title semibold in `text`, one line cut in the middle, two lines cut at the
end. Age `MetaText` 11 monospaced in `Own.tertiary`, or the waiting ink while
the card waits. Where: `Views/CardView.swift:202-236`.

### Status line

Status dot, the status words in the core's ink, the live helpers in
`Own.tertiary`, and on a compact card the PR and diff in words. Spacing 6.
Where: `Views/CardView.swift:240-276`.

### Status dot

A filled circle, or a hollow 1.5 ring for a hollow glyph, over a soft halo 3
wider each side, so dotted and plain rows line up. Fill from the core's ink,
`Own.grey` when it has none; halo from the core. Where:
`Views/CardView.swift:281-299`. Headers and the anchor badge draw their dot
as a text glyph instead ([gap H](#known-gaps)).

### Needs dot

A disc in the wait's colour on a badge tile's top corner, 0.36 of the badge,
ringed 2 in the face under it and set out by a third of its size. On a
Projects card it leads the title bare, at `headerDot` 7.
Where: `Views/BadgeTile.swift:40-68`.

### Badge tile

A project's SF Symbol in semibold on a rounded square of its colour; the
glyph is inked light or dark for contrast (`Model/BadgeInk.swift`). A project
with no colour takes the grey. Sizes and radii:

| Where | Size | Glyph | Radius |
|-|-|-|-|
| full card | 26 | 12 | 8 |
| compact card | 22 | 11 | 7 |
| project header, editor | 18 | 10 | 5 |
| quiet row | 16 | 9 | 5 |
| dense row | 14 | 8 | 4 |

Where: `Views/BadgeTile.swift:11-34`.

### Ready pill

"Ready" in `greenText` on `Own.readyBg`, the agent finished while you were
elsewhere. `Font.section` 10.5 medium; padding 7 by 1 and radius 8, all
literals ([gap A](#known-gaps)). Where: `Views/CardView.swift:302-313`.

### Unread badge

The unread count, white on grey in both appearances so clay only ever means
your turn. `Font.tiny` 10 bold, not monospaced; padding 5 by 1 (literals);
radius `Radius.tab` 7; `Own.badge` face, `Own.onBadge` ink.
Where: `Views/CardView.swift:316-328`.

### Count pill

A lane's or project's count. `Font.meta` 11 medium with monospaced digits;
padding `pillPadH` 7 by `pillPadV` 1; radius `Radius.pill` 10; face and ink
from the core. Where: `Views/LaneView.swift:4-17`.

### Meta text

A trailing age: `Font.meta` 11 monospaced, never cut.
Where: `Views/CardView.swift:331-342`.

### Chips

All chips are 11 (`Font.meta`) and share one frame: padding 6 by 1, radius
`Radius.chip` 6, `chipEdge` hairline (`chipFrame`, `Views/ChipsView.swift:24-33`).
The chips row puts everything on one line when it fits, else the branch line
under the PR line; only then does the diff give way, then the branch name.
Where: `Views/ChipsView.swift:43-173`.

#### Quiet chip

`chipFace` face, words medium in the core's inks.

#### PR chip

`arrow.triangle.pull` glyph at 9 semibold in `secondary`, the number medium,
the state regular in its health's ink. When it opens, the glyph turns to
`arrow.up.right` and the face takes `Own.hover`. On the full card it does not
open.

#### Branch chip

`arrow.branch` glyph, the name medium cut in the middle, a 5 `secondary` dot
when there are uncommitted changes.

#### Port chip

The port medium and monospaced.

#### Diff

The diff size unframed, regular, beside its PR. It is the first thing to go.

#### Action chip

A white button with the chip edge (for example Make project): `Own.card`
face, `Own.cardHover` under the pointer, words 11 medium, padding 7 by 1
(not the chip's 6, [gap C](#known-gaps)). Where: `Views/Actions.swift:135-163`.

### Dismiss x

On a waiting card under the pointer only: a 16 circle, `xmark` at 8 bold in
`secondary`, `Own.hover` face (`Own.cardHover` under its own pointer),
`cardEdge` ring. A waiting card keeps its slot at rest so the title does not
reflow. Where: `Views/CardView.swift:350-381`.

### Pin

`pin.fill` at 9.5 in `faint`: a property, not a control.
Where: `Views/CardView.swift:384-390`.

### Left off and detail

Where you left off: `Font.control` 12 in `Own.tertiary`, one line. Detail: 12
in `secondary` (or the core's ink), one or two lines.
Where: `Views/CardView.swift:393-425`.

### Progress bar

A 4 high capsule: `countBg` track, `blue` fill, 2 above.
Where: `Views/CardView.swift:428-445`.

### Card chrome

Every card's face, edge, dimming and hover (`Views/CardView.swift:463-492`).

- **Face:** `Own.card`, `Own.cardHover` under the pointer. A dense row has no
  face at rest and takes the `Own.hover` wash.
- **Edge at rest:** `cardEdge` hairline; none on a dense row.
- **Selected outline:** `select` (the heading ink) at 2, drawn inside so
  nothing moves (`Outline`, `CardView.swift:524-533`).
- **Dimmed:** a merged card nothing in it wants sits at 0.6, full strength
  under the pointer.

### Drag

While a card is dragged its slot stays as a dashed `cardEdge` outline
(1 wide, dash 4 and 3) and the other cards slide apart over 0.15s to open a
gap. The card itself floats over the lanes at the pointer: `Own.panelGround`
behind it, 0.9 opacity, an `Own.lift` shadow of radius 6 dropped 2. Both use
`Metrics.corner` 6, not the card's 12 ([gap C](#known-gaps)).
Where: `Views/Drag.swift:192-249`, `Views/LaneView.swift:189`.

### Editor sheet

The project editor as a sheet, 260 wide with 14 padding (literals). Title at
`Metrics.body` 12 semibold; labels at `Metrics.small` 11 in `faint`; the
badge preview at 18; colour swatches 14 with a 2 `text` ring on the chosen
one; icons in 24 by 22 cells, the chosen one on `countBg` with radius 4;
problems and Remove in `redText`. Where: `Views/EditorSheet.swift:9-186`.

### Message agent popover

From a card's right-click menu: a prompt line at 12 semibold, a text field,
Cancel and Send; "Not sent" at 11 in `clayText` when the core refuses. 280
wide with 12 padding (literals). Where: `Views/Actions.swift:83-129`.

### Notices

Two lines, a title at 12 semibold in `text` and why at 12 in `secondary`,
padded by the gutter. While the helper is down the panel shows one on an
`amberHalo` band above it. Where: `Views/PanelView.swift:76-114`.

## Wording

### Casing

- **Section headings** (lane names, QUIET) are in tracked capitals by
  `.textCase(.uppercase)` plus `Metrics.sectionTracking`. The string stays as
  the core or `Words` has it.
- **Names** (projects, workspaces, PR titles) are shown exactly as given.
- **Buttons, labels and menu items** are sentence case: "Message agent…",
  "New project", "Edit project", "Search icons", "Make project".
- **Marks** are single glyphs: ■ ▸ ▾ + ● ○.

### Where words come from

1. **The Rust core** owns everything that changes and most that does not:
   status words (`native/core/src/words.rs`), labels and marks
   (`native/core/src/panel/mod.rs:34-68`), menus, lane names, editor problems.
   The panel model carries them; views draw them as given.
2. **`Model/Words.swift`** holds the fixed words the sidebar draws itself:
   the switch labels, Next, the editor's labels and buttons, the notices.
   Where one mirrors a core constant the views test checks it against the core.
3. **Elsewhere, today:** `ActionWords` (`Views/Actions.swift:25-31`),
   `CardText.ready` (`Model/CardText.swift:132`), `LaneHeader.dropHere`
   (`Views/LaneView.swift:105`) and `ProjectText.newProjectLabel`
   (`Model/ProjectText.swift:35`). See [gap K](#known-gaps).

New words go in `Words.swift`, or come from the core.

## The code is right if

Each rule is a check you can run from `native/mac/Sidebar`. Where it fails on
main today, the failures are listed and tracked as a gap.

1. **No bare number in a font size.**
   `grep -rnE "size: [0-9]" Views | grep "\.font"` prints nothing.
   Passes today.
2. **Every colour is a token or an own colour.** No hex and no system colour
   in a view:
   `grep -rnE "0x[0-9A-Fa-f]{6}|RGBA\(0x|Color\.(white|black|gray|grey|red|blue|green|orange|yellow|primary|secondary)" Views`
   prints nothing. Passes today. The one colour from outside the palette is a
   project's own, through `Color(project:)`.
3. **No bare number in a corner radius.**
   `grep -rnE "cornerRadius: [0-9]" Views` prints nothing.
   Fails today: `EditorSheet.swift:167`, `CardView.swift:311` ([gap C](#known-gaps)).
4. **No bare number in padding or spacing outside a look enum.**
   `grep -rnE "padding\((\.[a-z]+, )?[0-9]|spacing: [1-9]" Views` prints nothing.
   Fails today: 36 lines, listed on the audit page ([gap C](#known-gaps)).
5. **A new colour is a pair.** Every case in `Palette.pair(_:)` names a light
   and a dark `RGBA`; `faint` is the only pair whose two sides match by accident
   ([gap L](#known-gaps)).
6. **A new word lives in `Words.swift` or comes from the core.**
   `grep -rnE "Text\(\"[A-Za-z]" Views` prints nothing. Passes today; the
   words outside `Words` are constants elsewhere ([gap K](#known-gaps)).
7. **No comment points at a TypeScript file or the pane.**
   `grep -rnE "\.ts\b|native/pane" .` prints nothing.
   Fails today: 52 lines. 49 of them name a TypeScript file (51 pointers in
   all) and 3 a pane path; in all, 19 lines lean on the pane
   ([gap 1](#known-gaps)).

## Known gaps

Each is open until decided. The audit page carries the evidence and the
decision cards; this list is the index.

| Gap | What | Where |
|-|-|-|
| 1 | Views and the views test define the look by pointing at TypeScript and the pane; the test reads those files, so retiring them fails it | 51 `.ts` pointers in 16 files; `native/mac/Tests/Views/main.swift:314`, `:379`, `:383`, `:389`, `:398`, `:412` |
| A | Four count treatments: unread badge, its copy in the anchor badge, the waiting count, the count pill; the Ready pill on literals | `CardView.swift:316-328`, `LaneView.swift:73-80`, `TopView.swift:65-84`, `LaneView.swift:4-17`, `CardView.swift:302-313` |
| B | Two names for one scale (`body`/`small` beside `Font.control`/`meta`; `CardLook.rowTitle` and `compactStatus` duplicate `Font.title` and `next`) | `Theme.swift:32-33`, `CardView.swift:40-41`, `ProjectsView.swift:126` |
| C | Spacing, size and radius literals outside a look enum | listed on the audit page |
| D | Badge radii have no stated rule, though all fit `round(0.3 × size)` | `CardView.swift:13`, `:18`, `:29`; `BadgeTile.swift:16`; `LaneView.swift:40` |
| E | Fades: 0.55 under two names, 0.6 dimmed, 0.9 dragged | `Theme.swift:110`, `ProjectText.swift:47`, `CardView.swift:47`, `Drag.swift:243` |
| F | Colours no view draws: `Own.ground`, `Own.cardFace`, `amberRowEdge`, `needsRowEdge`; `Metrics.cardIndent` unused; `Metrics.corner` duplicates radius 6 | `Palette.swift:33`, `:40`, `:136-137`; `Theme.swift:35`, `:45` |
| G | Eight views keep their own hover state beside the one shared hover shade | `ProjectsView.swift:60-78`; the eight other `@State private var hovering` sites |
| H | Status dots drawn as circles on cards and as text glyphs on headers | `CardView.swift:281-299`; `LaneView.swift:72`, `:146`; `ProjectsView.swift:121` |
| I | Card shapes differ in status weight, title weight and age ink | `CardView.swift:77`, `:107`, `:138`, `:157`, `:233-235` |
| J | Clay for "Not sent" and amber for the helper-down banner, where those hues mean your turn and asking | `Actions.swift:105`, `PanelView.swift:106` |
| K | Words outside `Words.swift`; "Drop here" differs in case from the core's "drop here"; Cancel defined twice | `LaneView.swift:105`, `native/core/src/panel/mod.rs:65`, `Actions.swift:29`, `Words.swift:34` |
| L | Dark mode is the extension's own: ground unsampled, `faint` one hex for both, `Own.cardFace` dark see-through | `Palette.swift:34-37`, `:94`, `:154` |
