# Native sidebar design reference

This describes the look of the native Mac left sidebar (`native/mac/Sidebar`,
SwiftUI) as it stands on main at `12d4303`. It is the one reference for that
look. The TypeScript sidebars (`src/cockpit`, `src/agents`) and the terminal
pane (`native/pane`) are being retired, so nothing here describes them. A
view comment points at the matching heading here (for example
`docs/design.md#full-card`), never at one of them.

Read it before changing a view, `Palette.swift` or `Theme.swift`, and update
it in the same PR when the look changes. Sections that describe a known
inconsistency say so and link to the [known gaps](#known-gaps).

Decisions D1 to D15 on the audit page are all decided, each as option a
(11 October 2026). Where one sets a rule for future work, the section says so
in a line that starts **Target (Dn a, not built yet)**. That line is the rule
to build towards; everything else in the section describes main today. A
target becomes today's description in the PR that builds it, listed in
[follow-up work](#follow-up-work).

File paths below are relative to `native/mac/Sidebar/` unless they say
otherwise. Line numbers are as of `12d4303`.

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
   (`CardLook`, `ChipLook`, `ProjectMetrics`, `EditorLook`, `MessageLook`,
   `DragLook`).

## Colour

`Model/Palette.swift` holds every colour literal in the extension. Core tokens
(`Token`, chosen by the Rust core in `native/core/src/theme.rs`) are mapped at
`Palette.swift:103-148`; the colours only the views need (`Palette.Own`) are at
`Palette.swift:150-169`. An alpha after the hex is written as `/ 0xAA`; a
"faint" token is its hue at that alpha, drawn over whatever is under it.

### The ground

The panel sits on `Own.panelGround`, **FAF9F5** light: cmux's own window
off-white, sampled from a light capture (`Model/Palette.swift`). Dark is
262624 and was not sampled (see [gap L](#known-gaps)).

**Target (D4 a, not built yet, blocked):** the dark ground and the dark side
of `faint` are sampled from a dark-mode capture of cmux, and the views test's
contrast checks are re-run against them. Blocked until Jon supplies a
dark-mode screenshot; nothing here changes before then.

### State hues

| Token | Light | Dark | Means | Where drawn |
|-|-|-|-|-|
| `clay` | D97757 | E08A6D | your turn | the waiting count on the All tab while one waiting card is your turn (core picks, `Needs.fill`); a needs dot |
| `amber` | D9A03F | E3B260 | asking | needs dot, status dot, the waiting count while every waiting card asks (core picks) |
| `blue` | 3B6FB6 | 6A9BE0 | working | progress bar fill (`CardView.swift` `ProgressBar`), status dot |
| `green` | 788C5D | 93A877 | finished | status dot (core picks) |
| `mergeGreen` | 1DB954 | 3DD171 | ready to merge | status dot (core picks) |
| `greenDeep` | 3F5A2B | A6C58A | nothing now | not drawn: left only under `greenChipEdge`, which no view draws; ready to merge is `mergeText` everywhere (D11 a) |
| `clayHalo` | clay / 0x38 | same | soft ring round a clay dot | status dot halo (core picks, `Icon.halo`) |
| `amberHalo` | amber / 0x38 | same | soft ring round an amber dot | status dot halo (core picks) |
| `blueHalo` | blue / 0x2E | same | soft ring round a blue dot | status dot halo (core picks) |
| `mergeHalo` | mergeGreen / 0x47 | same | soft ring round a merge dot | status dot halo (core picks) |

### State inks (words in a state)

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `clayText` | A34A2A | E8997C | status words, a waiting card's age (core picks) |
| `amberText` | 8A5A0B | E8BC6E | status words (core picks) |
| `blueText` | 2F5690 | 8FB4EC | status words (core picks) |
| `greenText` | 5E7A40 | A3BC85 | the Ready pill and Next's line (core picks: `Card.ready_ink`, the `NextLine` step's `ink`) |
| `mergeText` | 12873B | 5FD98A | "Ready to merge" in words, a lane's merge line, a PR chip's "ready", a dense row's ready PR number (core picks) |
| `redText` | 9E2F27 | E3796F | a failing PR; editor problems and Remove (`EditorSheet.swift:55`, `:59`); "Not sent" |

### Neutral inks

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `text` | 141413 | F0EEE6 | card titles, the chosen tab, notice titles |
| `heading` (also `select`, `laneMain`) | 3D3D3A | D6D4CA | project header names, a selected card's outline, "Drop here" |
| `secondary` (also `laneReview`) | 5E5D59 | B7B5A9 | lane names, detail lines, chip glyphs, the size chip, the tab not chosen, the fold chevron, a quiet row's "+" |
| `metaText` | 6B6A64 | A3A199 | Next's place, every age while its card waits on nobody, Idle and No agent, a quiet PR's words, the Quiet pill |
| `faint` (also `laneBackground`) | 8A8880 | 8A8880 | pin, QUIET, a faint or empty lane's name, a row's PR title, the diff, editor labels ([gap L](#known-gaps)) |
| `Own.tertiary` | 73726C | 9C9A92 | where you left off, live helpers, the editor's "Or one you have open" |
| `Own.grey` | A09E95 | 77756D | a dot with no colour; a project with no colour |

### Surfaces and edges

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `Own.panelGround` | FAF9F5 | 262624 | under the whole panel (`PanelView.swift:113`), under a floating card |
| `Own.card` | FFFFFF | 30302D | a card's face, the chosen tab, Next's pill, an action chip |
| `Own.cardHover` | F7F6F2 | 383835 | a card's face, or Next's pill, under the pointer |
| `Own.hover` | 7F7F7F / 0x14 | 7F7F7F / 0x24 | a header, tab, chip or quiet row under the pointer |
| `cardEdge` | text / 0x1F | same | a card's hairline, the chosen tab's edge, the dismiss x ring |
| `chipFace` | F1EFE8 | 30302D | a quiet chip's face |
| `chipEdge` | E2DFD3 | 484741 | a chip's edge, the view switch track's edge |
| `countBg` | E5E2D6 | 3A3935 | the switch track, progress bar track, chosen editor icon, the helper-down band |
| `Own.readyEdge` | green / 0x47 | same | Next's pill edge: the Ready pill's green, a step stronger so a hairline shows |
| `Own.readyBg` | green / 0x1F | same | the Ready pill's face |
| `Own.dropTarget` | text / 0x1F | same | a lane header while a card is dragged over it |
| `Own.zoneLit` | E7E4D9 | 3A3935 | an empty lane's drop zone while a card is over it |
| `Own.lift` | 000000 / 0x2E | 000000 / 0x66 | the shadow under a dragged card |

### Counts, chips and badges

| Token | Light | Dark | Where drawn |
|-|-|-|-|
| `Own.badge` | = `secondary` | = `secondary` | the unread badge's face |
| `Own.onBadge` | FFFFFF | 1F1E1D | the unread badge's number |
| `Own.onFill` | FFFFFF | FFFFFF | the number on the waiting count, on clay or amber |
| `blueCount`, `clayCount`, `amberCount` | hue / 0x1F, 0x29, 0x29 | same | a count pill's face in a state (core picks) |
| `redChipFace`, `redChipEdge` | red / 0x1A, 0x38 | same | not drawn: the core's `pr_chip_colors` (`native/core/src/pr_colors.rs:52`) has no caller outside its tests, and every PR chip sits on `chipFace` |
| `blueChipFace`, `blueChipEdge` | blue / 0x1A, 0x38 | same | not drawn, as above |
| `greenChipFace`, `greenChipEdge` | green / 0x29, greenDeep / 0x59 | same | not drawn, as above |

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

Every unused colour has gone ([gap F](#known-gaps)): the core's
`amberRowEdge` and `needsRowEdge`, and the sidebar's `Own.ground`,
`Own.cardFace`, `Own.needsEdge` and `Own.needsHover`. The views test
checks contrast on `Own.card`, the face cards are drawn on. The six PR
chip faces and edges (`redChipFace` to `greenChipEdge`) are chosen by a
core function nothing calls, so a PR's health shows only in the ink of
its words; `greenDeep` is left only under `greenChipEdge`.

## Type scale

Every type size is a named constant; no view passes a bare number to
`.font(.system(size:))`. Eleven distinct sizes are in use once glyphs are
counted. Weights are named beside each use.

| Size | Names | What draws with it |
|-|-|-|
| 13.5 | `Metrics.Font.cardTitle` | a full card's title, semibold |
| 13 | `Metrics.Font.compactTitle` | a compact card's title, semibold |
| 12.5 | `Metrics.Font.title` | project header name (semibold), quiet row and New project label (regular), a dense row's title (regular, medium when selected), a Projects card's title (semibold) |
| 12 | `Metrics.Font.control`, `CardLook.fullBadgeFont` | the view switch's tabs (medium), a full or Projects card's status (medium), detail, left off, notices, the editor and Message agent (body); a full card's badge glyph |
| 11.5 | `Metrics.Font.next` | Next's line (semibold), a compact card's status (regular) |
| 11 | `Metrics.Font.meta`, `CardLook.compactBadgeFont`, `ProjectMetrics.plusFont` | ages, count pills (medium, digits monospaced), chip words, a lane or project header row, the waiting tab (`TabPillLook.font` is this name), editor labels and notes, "Not sent"; a compact badge glyph; the header "+" |
| 10.5 | `Metrics.Font.section` | section headings in tracked capitals (semibold); the Ready pill (medium) |
| 10 | `Metrics.Font.tiny`, `ProjectMetrics.headerBadgeFont`, `ProjectMetrics.rowPlusFont` | fold chevron, unread badge, waiting count (bold); project header badge glyph; quiet row "+" |
| 9.5 | `CardLook.pin` | the pin |
| 9 | `ChipLook.glyph`, `ProjectMetrics.quietBadgeFont` | PR and branch glyphs in a chip; a quiet project's badge glyph |
| 8 | `CardLook.rowBadgeFont`, `Metrics.dismissGlyph` | a dense row's badge glyph; the dismiss x (bold) |

The `Metrics.Font` enum (`Views/Theme.swift`) is the one naming system for
text and covers 10 to 13.5 (D2 a). Glyph sizes stay in their look enums
(`CardLook`, `ChipLook`, `ProjectMetrics`, `Metrics.dismissGlyph`). A new
text size gets a `Metrics.Font` name or reuses one.

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
| `Metrics.pillPadH`, `pillPadV` | 7, 1 | inside every count pill, and the Ready pill |
| `Metrics.switchHeight`, `switchInset` | 26, 3 | a tab's height; the track's inner padding |
| `Metrics.hairline`, `selectWidth` | 1, 2 | every edge; a selected card's outline |
| `Metrics.inlineGap` | 6 | between the parts of a line in a card, a tab or Next |
| `Metrics.minGap` | 4 | the least room between a line's words and what ends it: a title and its pills, a header row and its hint or + |
| `Metrics.switchGap`, `topGap` | 8, 6 | under the view switch; above Next and above the view |
| `Metrics.nextPadH`, `nextPadV` | 8, 5 | inside Next's pill |
| `Metrics.anchorPad`, `anchorGap` | 4, 5 | inside an anchor badge; glyph to count |
| `Metrics.noticeGap` | 4 | a notice's title to its why |
| `Metrics.chevronWidth`, `chevronHeight` | 12, 16 | the fold chevron's slot, so names line up |
| `Metrics.laneMarker`, `headerDot` | 9, 7 | a lane's square marker; a header's dot |
| `Metrics.dismissSize` | 16 | the dismiss x's circle |
| `Metrics.needsDotShare`, `needsDotRing` | 0.36, 2 | a needs dot as a share of its badge, and its ring |
| `Metrics.emptyFade` | 0.55 | an empty lane's marker and count |

### Card spacing (`CardLook`)

In `Views/CardView.swift`.

| Name | Value | Use |
|-|-|-|
| `padLeading`, `padTrailing`, `padV` | 10, 12, 11 | inside a full or compact card |
| `fullGap`, `compactGap` | 10, 9 | badge to text |
| `rowPadLeading`, `rowPadV` | 25, 5 | inside a dense row, so its dot sits under the lane marker |
| `rowIndent` | 7 + 6 + 6 + 14 + 6 | a dense row's second line starts under its title |
| `projectPad`, `projectGap` | 10, 5 | inside a Projects card; above its chips and bar |
| `fullColumn`, `compactColumn`, `rowColumn` | 4, 3, 2 | between the lines of a full card, a compact card, a dense row |
| `projectStatusTop`, `projectDetailTop` | 2, 3 | above a Projects card's status line (and waiting tab), and its detail |
| `bar`, `barTop` | 4, 2 | the progress bar's height, and the gap above it |
| `statusDot`, `compactStatusDot` | 7, 6 | a card's status dot (full, dense row, Projects card); a compact card's |
| `hollowRing` | 1.5 | a hollow status dot's ring |
| `titleLine` | 1.2 | a title's first line as a share of its size, where a leading needs dot centres |
| `dimmed` | 0.6 | a merged card nothing in it wants |

### Chips (`ChipLook`)

In `Views/ChipsView.swift`. `padH` 6, `padV` 1, `inner` 4 (glyph to words),
`dirty` 5 (the dot), `gap` 5 between chips, `lineGap` 4 between chip lines.

### Projects view (`ProjectMetrics`)

In `Views/ProjectsView.swift`. Header badge 18, quiet badge 16, "+" button
20, row padding 3, row radius 7, Quiet heading padding 4, gap above Quiet 10,
gap above New project 6.

### Radii (`Metrics.Radius`)

In `Views/Theme.swift`.

| Name | Value | Use |
|-|-|-|
| `card` | 12 | full and compact cards |
| `row` | 9 | a dense row, a Projects card |
| `track` | 10 | the view switch's track |
| `pill` | 10 | every count pill: a lane's or project's count, the unread badge, the waiting count |
| `header` | 8 | a lane or project header, the Quiet heading, an empty lane's zone |
| `tab` | 7 | a switch tab, Next's pill |
| `anchor` | 6 | an anchor badge's face |
| `chip` | 6 | every chip |
| `ready` | 8 | the Ready pill |
| `iconCell` | 4 | the editor's chosen icon cell |

A badge tile's radius is `round(0.3 × size)`, worked out in
`Model/BadgeCorner.swift` rather than typed per size (D3 a), and pinned by
the views test: 26 takes 8, 22 takes 7, 18 and 16 take 5, 14 takes 4. The
lane marker takes the same rule, 3 at 9. Every other surface takes one
radius per kind, named above. The drag's gap outline and floating card take
the dragged card's own corner: 12 for a full or compact card, 9 for a dense
row.

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

White number on a pill on the All tab; a click steps to the next
waiting card. `Font.tiny` 10 bold, monospaced; the
[count pill](#count-pill)'s shape (D1 a). The face is the core's
`Needs.fill` (D8 a): clay, or amber while every waiting card is an agent
asking and none is late. The number is `Own.onFill`, white on either.
The core's `Needs.ink` is the fill's text ink, for words drawn without
the fill (the pane's Needs line); a text ink on its own fill would not
read, so the sidebar does not draw it. Where: `Views/TopView.swift`
(`NeedsCount`).

### Next

A white pill with a green edge, "Next: <title>" in Ready's green cut in
the middle, the place in the queue on the right. Shown only while nothing
waits, so it only ever leads to a Ready card (D9 a). Face `Own.card`,
`Own.cardHover` under the pointer like any solid face; edge
`Own.readyEdge`; radius `Radius.tab` 7; padding `nextPadH` 8 by
`nextPadV` 5. Title `Font.next` 11.5 semibold in the core's ink (the
`NextLine` step's `ink`, `greenText`); place `Font.meta` 11 monospaced
`metaText`. Where: `Views/TopView.swift` (`NextView`).

### Lane header

Fold chevron, the lane's square marker, the name in tracked capitals, an
anchor badge if the lane has one, the count pill, the folded lane's dot, and
on the right the merge line ("2 ready to merge") or "Drop here" during a drag,
both words and ink from the core.
Lights grey under the pointer, and with `Own.dropTarget` while a card is over
it. An empty lane draws as a drop zone: no chevron, marker and count at
`emptyFade` 0.55 (the count in the core's tint, faded but never faint as
well, D12 a), and while a card is over it an `Own.zoneLit` face with a
`heading` hairline.

Padding `headerPadH` 8, `headerPadV` 5; radius `Radius.header` 8; spacing
`headerSpacing` 8; gap above `sectionGap` 14 less the vertical padding. Name
`Font.section` 10.5 semibold, `secondary` (or `faint` for a faint lane). Row
size `Font.meta` 11. "Drop here" is the lane's `drop_hint` (medium, in
`heading`) and the merge line's ink its `merge_ink`, both from the core's
`header_hint` rule (`drop_hint` and `merge_ink` in
`native/core/src/lane_entries.rs`, D8 a). The merge line is in `mergeText`,
the ink every other "ready to merge" uses (D11 a), or `faint` in a faint
lane. Where: `Views/LaneView.swift` (`LaneHeader`).

### Fold chevron

`chevron.right` at `Font.tiny` 10 semibold in `secondary`, as it is a
control (D12 a), turned down when open, in a 12 by 16 slot.
Where: `Views/LaneView.swift` (`FoldMark`).

### Lane marker

A rounded square in the lane's colour, 9 square, radius by the badge rule (3).
Where: `Views/LaneView.swift:35-44`.

### Anchor badge

On a lane header, a lane's generated workspace with no card: its status glyph
and unread count, a click opens it. Face clear, `Own.hover` under the
pointer; while selected, a 1 `select` outline like a card (D13 a), so it
never matches a lane under a drag; radius `Radius.anchor` 6; height 16;
padding 4. The unread count inside is the [unread badge](#unread-badge)
view itself (D1 a). Where: `Views/LaneView.swift` (`AnchorBadge`).

### Project header

Fold chevron, the project's [badge tile](#badge-tile) at 18 with a 10 glyph,
the name, the count pill, the folded project's dot, and a round "+" when the
project has a folder. Name `Font.title` 12.5 semibold in `heading`. Padding,
radius and gap as the lane header; hover through the shared hover shade.
Where: `Views/ProjectsView.swift:106-134`. The row's own size is
`Font.meta` 11, as on the lane header.

### Plus button

A 20 circle with `plus` at 11 semibold in `secondary`, grey under the
pointer. Where: `Views/ProjectsView.swift:83-99`.

### Quiet header

Fold chevron, QUIET in tracked capitals in `faint`, the count pill in the
core's `QUIET_PILL`, carried on the row (D8 a). Padding 8 by 4, radius 8,
10 above it. Where: `Views/ProjectsView.swift` (`QuietHeader`).

### Quiet row

A project with no sessions: 16 badge with a 9 glyph, name at `Font.title`
12.5 regular in `secondary`, and a "+" in `secondary` when it has a folder,
as it is a control (D12 a). A row with no folder takes no click and fades
to `ProjectText.disabledFade` 0.55 (cannot click), named apart from
`emptyFade` (nothing here). Padding 8 by 3, hover radius 7.
Where: `Views/ProjectsView.swift` (`QuietRow`).

### New project row

"+ New project" styled as a quiet row: a 10 semibold plus in the 16 badge
slot, the label in `secondary` at 12.5. Six above it.
Where: `Views/ProjectsView.swift:218-243`.

### Full card

The badge tile (26, glyph 12, radius 8) beside a column of: the title row, the
status line, the chips, the detail over up to two lines, the progress bar.
Badge to text 10; padding 10 leading, 12 trailing, 11 above and below; column
spacing `fullColumn` 4. Title `Font.cardTitle` 13.5 semibold over two lines;
status `Font.control` 12 medium with a 7 dot. Radius `Radius.card` 12, with
the [card chrome](#card-chrome). Where: `Views/CardView.swift:66-90`.

### Compact card

A smaller badge (22, glyph 11, radius 7), the title on one line, the status
line with the PR in words and its diff faint after it, where you left off,
the detail, the progress bar. Badge to text 9; same padding as the full card;
column spacing `compactColumn` 3. Title `Font.compactTitle` 13 semibold; status
`Font.next` 11.5 regular with a 6 dot. A quiet PR's words are `metaText`,
as on a chip and a dense row (D14 a, `compact_pr` in
`native/core/src/panel/build.rs`). Radius 12.
Where: `Views/CardView.swift` (`CompactCard`).

### Dense row

One line: status dot (7), a 14 badge (glyph 8, radius 4), the title, its PR's
title faint after it, then unread, PR number, age, dismiss x, pin; under it
left off and the detail, indented to the title. No face until selected; grey
wash under the pointer. Title `Font.title` 12.5 regular (medium when
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
end. Age `MetaText` 11 monospaced in `metaText`, as on a dense row, or the
waiting ink while the card waits (D14 a, `CardText.ageInk`). Where:
`Views/CardView.swift` (`TitleRow`).

### Status line

Status dot, the status words in the core's ink, the live helpers in
`Own.tertiary`, and on a compact card the PR and diff in words. Spacing 6.
"No agent" is in `metaText` with Idle, never `faint` (D12 a,
`plain_style` in `native/core/src/status.rs`).
Where: `Views/CardView.swift` (`StatusLine`).

**Target (D15 a, not built yet):** the blue status
for an idle agent whose background shell still runs is renamed from
"Waiting" (`WAITING_WORD`, `native/core/src/words.rs:27`) so "waiting" only
ever means waiting on you (D15). The working name is "Shell running";
**Jon to confirm the word** before that PR is built.

### Waiting tab line

On a waiting card whose workspace runs two or more agents, the tab the
waiting one runs in, drawn as a pill shaped like a tab: the tab's title
alone, as cmux's tab bar shows it less Claude Code's status glyph, 11
regular in `secondary`, one line cut at the end. The pill hugs its text
from the leading edge, never wider than the card's column: fill
`chipFace`, a 1pt edge in `chipEdge` with the bottom edge in `cardEdge`,
top corners radius 6 and bottom corners square, padding 8 leading and
trailing, 1 top and 2 bottom.
It sits under the status line on a full, compact and Projects card (2
above it on a Projects card), and under the detail on a dense row,
indented to the title. Only agents that have not ended count towards the
two. No pill with one agent, nothing waiting, or a tab with no title (or
only "Claude Code"); the space it would take goes with it. A click on the
card selects the workspace, then that tab, even when the tab has no title
to show. Where: `Views/CardView.swift` (`WaitingTabLine`, `TabPillLook`);
the core sets `Card.waiting_tab` (`native/core/src/panel/build.rs`).
Issue #329.

### Status dot

A filled circle, or a hollow 1.5 ring for a hollow glyph, over a soft halo 3
wider each side, so dotted and plain rows line up. Fill from the core's ink,
`Own.grey` when it has none; halo from the core's `Icon.halo` (D8 a),
clear on a hollow dot and on finished green. Where:
`Views/CardView.swift` (`StatusDot`). Headers and the anchor badge draw their dot
as a text glyph instead ([gap H](#known-gaps)).

### Needs dot

A disc in the wait's colour on a badge tile's top corner, 0.36 of the badge,
ringed 2 in the face under it and set out by a third of its size. On a
Projects card it leads the title bare, at `headerDot` 7.
Where: `Views/BadgeTile.swift:40-68`.

### Badge tile

A project's SF Symbol in semibold on a rounded square of its colour; the
glyph is inked light or dark for contrast (`Model/BadgeInk.swift`). A project
with no colour takes the grey. Sizes and radii (the radius is
`round(0.3 × size)`, worked out by `BadgeCorner`):

| Where | Size | Glyph | Radius |
|-|-|-|-|
| full card | 26 | 12 | 8 |
| compact card | 22 | 11 | 7 |
| project header, editor | 18 | 10 | 5 |
| quiet row | 16 | 9 | 5 |
| dense row | 14 | 8 | 4 |

Where: `Views/BadgeTile.swift:11-34`.

### Ready pill

"Ready" in the core's `Card.ready_ink` (`greenText`, D8 a) on
`Own.readyBg`, the agent finished while you were elsewhere. `Font.section`
10.5 medium; padding `pillPadH` 7 by `pillPadV` 1, the count pill's
(D1 a); radius `Radius.ready` 8, its own, as it is not a count.
Where: `Views/CardView.swift` (`ReadyPill`).

### Unread badge

The unread count, white on grey in both appearances so clay only ever means
your turn. `Font.tiny` 10 bold, not monospaced; the
[count pill](#count-pill)'s shape (D1 a); `Own.badge` face, `Own.onBadge`
ink. A card's title row, a dense row and the anchor badge draw the same
view. Where: `Views/CardView.swift` (`UnreadBadge`).

### Count pill

One pill shape for every count (D1 a): padding `pillPadH` 7 by `pillPadV`
1, radius `Radius.pill` 10 (`countPillShape`). A lane's or project's count
is `Font.meta` 11 medium with monospaced digits, face and ink from the core.
The unread badge and the waiting count take the same shape; colour follows
meaning (grey unread, the core's tint on lane and project counts and the
Quiet heading, the core's fill on the waiting count). Where: `Views/LaneView.swift` (`CountPill`,
`countPillShape`).

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
the state regular in its health's ink. A PR GitHub would merge says "ready"
in `mergeText` (`READY_INK`, `native/core/src/pr_colors.rs`, D11 a), and a
dense row's ready PR number takes the same ink. When it opens, the glyph
turns to `arrow.up.right` and the face takes `Own.hover`. On the full card
it does not open.

#### Move size chip

On a card waiting on you, how big answering is: "quick", "decide" or
"review". A quiet chip (D10 a): the size is in `secondary` on the neutral
chip, like the branch; the card's own clay or amber already says it
waits (`chip_views`, `native/core/src/panel/build.rs`).

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
(`ActionChip.padH`, a step wider than the chip's 6). Where: `Views/Actions.swift:135-163`.

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
behind it, 0.9 opacity, an `Own.lift` shadow of radius 6 dropped 2. Both take
the dragged card's own corner: `Radius.card` 12 for a full or compact card,
`Radius.row` 9 for a dense row.
Where: `Views/Drag.swift:192-249`, `Views/LaneView.swift:189`.

### Editor sheet

The project editor as a sheet, 260 wide with 14 padding (`EditorLook`, which
names every measure in the sheet). Title at
`Font.control` 12 semibold; labels at `Font.meta` 11 in `faint`; the
badge preview at 18; colour swatches 14 with a 2 `text` ring on the chosen
one; icons in 24 by 22 cells, the chosen one on `countBg` with radius
`Radius.iconCell` 4;
problems and Remove in `redText`. Where: `Views/EditorSheet.swift:9-186`.

### Message agent popover

From a card's right-click menu: a prompt line at 12 semibold, a text field,
Cancel and Send; "Not sent" at 11 in `redText` when the core refuses: a
failure, so red like the editor's problems (D5 a). 280 wide with 12 padding
(`MessageLook`). Its words are in `Words.swift`. Where:
`Views/Actions.swift` (`MessageAgent`).

### Notices

Two lines, a title at 12 semibold in `text` and why at 12 in `secondary`,
padded by the gutter. While the helper is down the panel shows one on a
`countBg` band above it: a notice, not an ask, so it takes no state hue
(D5 a). Where: `Views/PanelView.swift` (`Notice`, `SidebarView`).

## Meaning

The tables above say what each token is. This section says what each look
means, so the same meaning looks the same in every place and one look never
stands for two things. Paths under `native/core/src` are the core's choices;
the rest are the views that draw them. The audit page carries the full matrix
and the decision cards D8 to D15; where a rule fails today it names the gap.
Every card is decided as option a; where that changes a rule, the rule says
**Target** and what is built today follows it.

### The grammar

1. **The core chooses state tokens; views draw them as given.** A view never
   names a state hue or state ink itself.
   `grep -rnE "Token\.(clay|amber|blue|green|mergeGreen|greenDeep|clayText|amberText|blueText|greenText|mergeText|amberHalo|clayHalo|blueHalo)\b" Views`
   should print only the progress bar's fill (`CardView.swift`
   `ProgressBar`, blue for working). Passes (D8 a): the waiting count, the
   Ready pill's ink, Next's ink (D9 a), the empty and Quiet pills, the
   halo, "Drop here" and the merge line all take the core's value, from
   panel model fields (`Needs.fill`, `Card.ready_ink`, the `NextLine`
   step's `ink`, `Lane.pill`, the Quiet row's `pill`, `Icon.halo`,
   `Lane.drop_hint`, `Lane.merge_ink`).
2. **A state is a dot plus words, and the dot and the words are a fixed
   pair:** `blue`/`blueText` working, `clay`/`clayText` your turn,
   `amber`/`amberText` asking, `green`/`greenText` finished,
   `mergeGreen`/`mergeText` ready to merge, no colour (`Own.grey`) with
   `metaText` idle. The pairs are set once in `status.rs:108-114` and
   `:136-170`. A filled dot in a live state (working, your turn, asking, ready
   to merge) carries its halo; a quiet one (finished, idle) does not; a
   hollow dot means the agent is there but not active (quiet working in blue,
   idle and no agent in grey).
3. **A state hue marks that state and nothing else.** Not a queue (Next), not
   a size (the move size chip), not an error, not a warning. Failures are
   red and the helper-down band is neutral (D5 a). Passes: Next is in
   Ready's green, as it only leads to a Ready card (D9 a), and the size
   chip is neutral (D10 a).
4. **A state on a header is the same dot as on a card.** Today headers and
   the anchor badge draw a text glyph ([gap H](#known-gaps)).
5. **A count is a pill**, coloured by how urgent what it counts is
   (`ui.rs:54` `count_tint`). The unread count is grey because unread is not a
   state. Every count takes the one count pill's shape (D1 a), colour by
   meaning.
6. **Hover:** anything that takes a click lights under the pointer. A solid
   face steps to `Own.cardHover`; a clear surface takes the `Own.hover` wash.
   No hover is tinted: Next steps to `Own.cardHover` like any solid face
   (D9 a).
7. **Selection is the heading ink.** A selected card or row is outlined in
   `select` at 2, and a selected anchor badge at 1: selection is the
   heading outline everywhere in the panel (D13 a). The view switch's
   chosen tab and the editor's chosen colour and icon (a `text` ring on a
   colour, a `countBg` cell on an icon) keep the system's own looks, as the
   only named exceptions.
8. **Faint ink means less important information.** It is never a state and
   never "you cannot click this". `grep -rn "Token.faint" Views` lists every
   use, none of them a control: controls (the fold chevron, a quiet row's
   "+") are drawn in `secondary` at least, and "No agent" is in `metaText`
   with Idle (D12 a).
9. **Fading by opacity means nothing to act on here:** an empty lane
   Three named meanings (D12 a): `emptyFade` (`Metrics`) is nothing here,
   an empty lane's marker and count; `disabledFade` (`ProjectText`) is
   cannot click, a quiet project with no folder (both 0.55); and a merged
   card's `dimmed` 0.6 means finished history, and lifts under the
   pointer. Nothing is both faint and faded: an empty lane's count takes
   the core's tint, only faded.
10. **An age is `MetaText` in `metaText`**, or the waiting ink while the card
    waits, on a title row and a dense row alike (D14 a, `CardText.ageInk`).
    `Own.tertiary` is where you left off and live helpers.
11. **A PR's state is words in its health's ink** (`pr_colors.rs:31` `pr_ink`):
    `redText` failing or conflicting, `blueText` checks running,
    `metaText` quiet, `mergeText` ready to merge. Ready to merge is
    `mergeText` everywhere it means ready to merge (D11 a), and quiet is
    `metaText` everywhere, the compact card included (D14 a).
12. **Errors are `redText`; notices are neutral.** `grep -rn "Token.clayText" Views`
    prints nothing: "Not sent" is `redText`, the helper-down band sits on
    `countBg` (D5 a), and Next is green (D9 a).
13. **"Waiting" means waiting on you, and nothing else.** Today the blue
    status for a running shell is also "Waiting" ([gap T](#known-gaps)).
    **Target (D15 a):** that status is renamed; the working name is "Shell
    running", **Jon to confirm**.

### The matrix, compact

One line per meaning that is drawn in more than one place, as main draws it
today; the targets above say where each **≠** is going. "Glyph" is the
core's ● or ○ drawn as text; "dot" is a drawn circle. A mismatch is marked
**≠**.

| Meaning | Cards (full, compact, Projects) | Dense row | Headers and anchor | Elsewhere | Chosen at |
|-|-|-|-|-|-|
| Your turn | clay dot with halo, `clayText` words, clay needs dot | same, age and reason in `clayText` | clay glyph **≠**; `clayCount` pill | clay waiting count on All | `status.rs` `plain_style`, `waiting_tokens`; `panel/build.rs` `header_dot` |
| Asking | amber dot with halo, `amberText` words, amber needs dot | same | amber glyph **≠**; `amberCount` pill | waiting count amber while every waiting card asks | `status.rs` `StatusKind::style`; `panel/build.rs` `needs_tone` |
| Working | blue dot with halo, `blueText`; blue progress bar | blue dot | blue glyph; `blueCount` pill | | `status.rs:109` |
| Waiting on a shell | as working, the word "Waiting" **≠** | as working | as working | "waiting" elsewhere means your turn | `status.rs:166-169`; `words.rs:27` |
| Quiet working | hollow blue ring, `blueText` | same | hollow glyph | | `status.rs:160-165` |
| Finished, Ready | olive dot, no halo, `greenText`; Ready pill `greenText` on `Own.readyBg` | olive dot; no Ready pill **≠** | olive glyph | Next in `greenText` | `status.rs`; `panel/build.rs` `ready_ink` |
| Idle, no agent | hollow grey; `metaText` idle and no agent | hollow grey | hollow grey glyph | | `status.rs` `plain_style` |
| Ready to merge | `mergeGreen` dot with halo, `mergeText` words | same, ready PR number `mergeText` | merge line in `mergeText` | PR chip "ready" in `mergeText` | `status.rs`; `lane_entries.rs` `merge_ink`; `pr_colors.rs` `READY_INK` |
| PR quiet (draft, open, closed) | chip state `metaText`; compact words `metaText` | number `metaText` | | | `pr_colors.rs` `pr_ink`; `panel/build.rs` `compact_pr`, `row_pr` |
| Checks failing, conflict | chip words `redText` on a neutral chip | number `redText` | | | `pr_colors.rs:33` |
| Checks running | chip words `blueText` (blue also means working) | number `blueText` | | | `pr_colors.rs:34` |
| Move size | chip words `secondary` on the quiet chip | not drawn | | | `panel/build.rs` `chip_views` |
| Unread | grey badge | grey badge | the same badge on the anchor | | `CardView.swift` `UnreadBadge` |
| Needs dot | on the badge corner; leads the title on a Projects card | on the 14 badge | glyph on headers **≠** | | `status.rs:248`; `panel/build.rs:568` |
| Selected | `select` outline at 2 | face, outline, medium title | `select` outline at 1 on the anchor | chosen tab: white face; editor: `text` ring or `countBg` cell (the named exceptions) | `CardView.swift` `Outline`, `LaneView.swift` `AnchorBadge`, `EditorSheet.swift` |
| Age | `metaText`, or the waiting ink | `metaText`, or the waiting ink | | Next's place `metaText` | `CardText.ageInk` |
| Error | | | | editor `redText`; "Not sent" `redText` | `EditorSheet.swift:59`, `Actions.swift:105` |
| Notice | | | | neutral words; stale band on `countBg` | `PanelView.swift` `SidebarView` |

### Where the views override the core

The core picks a token and the view draws another, or the view copies a core
constant: a place a core change would not reach the screen. None is left
(D8 a). The waiting count, an empty lane's pill, the Quiet pill, the status
dot's halo, "Drop here" and the merge line's ink all draw the panel
model's value. The one core colour the sidebar leaves undrawn on purpose
is `Needs.ink`, the fill's text ink, which the pane draws its Needs line
in; the sidebar sets the count's number in `Own.onFill` on the fill.

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
2. **`Model/Words.swift`** holds every fixed word the sidebar draws itself:
   the switch labels, Next, Ready, the editor's labels and
   buttons, Message agent's, the notices, and one Cancel for both the
   editor and Message agent. Where one mirrors a core constant the views
   test checks it against the core. `ProjectText.newProjectLabel` is worked
   out from `Words.newProject`. "Drop here" is the core's, carried on each
   lane as `drop_hint`.

New words go in `Words.swift`, or come from the core.

**Target (D15 a, not built yet):** "waiting" in any form means a card waits
on you. The blue status for a running shell (`WAITING_WORD`,
`native/core/src/words.rs:27`) gets its own word; the working name is "Shell
running", **Jon to confirm**.

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
   `grep -rnE "cornerRadius: [0-9]" Views` prints nothing. Passes (D3 a).
4. **No bare number in padding or spacing outside a look enum.**
   `grep -rnE "padding\((\.[a-z]+, )?[0-9]|spacing: [1-9]" Views` prints nothing.
   Passes.
5. **A new colour is a pair.** Every case in `Palette.pair(_:)` names a light
   and a dark `RGBA`. Two pairs have equal sides: `Own.onFill` is white in
   both on purpose, and `faint`'s match by accident ([gap L](#known-gaps)).
6. **A new word lives in `Words.swift` or comes from the core.**
   `grep -rnE "Text\(\"[A-Za-z]" Views` prints nothing, and every fixed word
   is a constant in `Words`. Passes.
7. **No comment points at a TypeScript file or the pane.**
   `grep -rnE "\.ts\b|native/pane" .` prints nothing, and neither does
   `grep -rn "cockpit's" .`. Passes (D6 a): each pointer is a
   `docs/design.md` anchor, for example `(docs/design.md#full-card)`. The
   only comments that still name the pane say what the views test compares
   against (its snapshots).
8. **The views test pins its own values.** Passes (D7 a). The light
   hexes, the quiet fade and the editor's words are written into
   `native/mac/Tests/Views/main.swift`; it reads no TypeScript or pane
   source, only the core's, found from the test's own path.
   `grep -nE '\.\./src/|pane/src/' ../Tests/Views/main.swift` prints
   nothing. The card and Projects words still compare against the pane's
   snapshots, given as its second argument.

## Known gaps

The audit page carries the evidence and the decision cards; this list is
the index. All fifteen decisions are made, each as option a. A gap marked
**Decided** stays open until the PR in [follow-up work](#follow-up-work)
that builds it lands; until then the sections above describe main as it is.
Gaps with no decision (G and H) are tidy-ups that ride along with a
follow-up PR.

| Gap | What | Where |
|-|-|-|
| 1 | Views defined the look by pointing at TypeScript and the pane. **Built: D7 a**, the views test pins its own values. **Built: D6 a**, comments point at `docs/design.md` anchors | closed |
| A | Four count treatments and the Ready pill on literals. **Built: D1 a**, one count pill shape for every count, colour by meaning | closed |
| B | Two names for one scale. **Built: D2 a**, one `Metrics.Font` naming, no size changes | closed |
| C | Spacing and size literals outside a look enum. **Built**: D3 a named the radius literals, and the spacing literals and the status dot sizes are named in `Metrics` and each view's look enum; the count paddings went with gap A | closed |
| D | Badge radii had no stated rule. **Built: D3 a**, badge radius is `round(0.3 × size)` worked out in `BadgeCorner`, pinned by the views test | closed |
| E | Fades: 0.55 under two names, 0.6 dimmed, 0.9 dragged. **Built: D12 a**, `emptyFade` nothing here, `disabledFade` cannot click, `dimmed` merged | closed |
| F | Colours and sizes no view draws. **Built**: `Own.ground`, `Own.cardFace`, `Metrics.cardIndent`, `Metrics.corner`, the core's `amberRowEdge` and `needsRowEdge`, and with D9 `Own.needsEdge` and `Own.needsHover` are gone | closed |
| G | Eight views keep their own hover state beside the one shared hover shade | `ProjectsView.swift:60-78`; the eight other `@State private var hovering` sites |
| H | Status dots drawn as circles on cards and as text glyphs on headers | `CardView.swift:281-299`; `LaneView.swift:72`, `:146`; `ProjectsView.swift:121` |
| I | Card shapes differ in status weight, title weight and age ink. **Built in part: D14 a**, every age is `metaText` or the waiting ink; the weights have no card | `CardView.swift` `FullCard`, `CompactCard`, `DenseRow`, `CardView` |
| J | Clay for "Not sent" and amber for the helper-down banner. **Built: D5 a**, red for failures, neutral for helper down | closed |
| K | Words outside `Words.swift`; Cancel defined twice. **Built**: every fixed word is in `Words.swift`, one Cancel, and "Drop here" is the core's (D8 a) | closed |
| L | Dark mode is the extension's own: ground unsampled, `faint` one hex for both. **Decided: D4 a**, sample from a dark capture of cmux; blocked on a dark-mode screenshot from Jon | `Palette.swift`: `panelGround`'s dark side, the `faint` pair |
| M | The waiting count on All was always clay. **Built: D8 a**, it takes the core's `Needs.fill`, amber while every waiting card asks | closed |
| N | Next was drawn in your turn's clay, though it always leads to a Ready card. **Built: D9 a**, Next in Ready's green | closed |
| O | The move size chip borrowed three state inks. **Built: D10 a**, the size chip is neutral | closed |
| P | Ready to merge was `greenDeep` on the lane's merge line and a PR chip's "ready". **Built: D11 a**, `mergeText` for ready to merge everywhere | closed |
| Q | Selection had five looks. **Built: D13 a**, the heading outline in the panel (the anchor badge outlined, `Own.anchorSelected` gone), system looks for the switch and the editor | closed |
| R | Faint ink was also a state ("No agent") and two controls; 0.55 meant both empty and cannot click. **Built: D12 a**, three named faint and fade meanings | closed |
| S | A quiet PR's words were `secondary` on a compact card; the PR chip faces are never drawn. **Built: D14 a**, quiet PR words and every age in `metaText`. Left: the chip faces, undrawn by design | `native/core/src/pr_colors.rs` `pr_chip_colors` |
| T | "Waiting" names a blue status (a shell still running) and, everywhere else, a card that waits on you. **Decided: D15 a**, rename the blue status; "Shell running" is a placeholder, Jon to confirm | `native/core/src/words.rs:27`; `native/core/src/status.rs:166-169` |
| U | Views picked or copied what the core picks. **Built: D8 a**, the Ready pill's ink, the empty and Quiet pills, the halo and the drop hint come from the panel model | closed |

## Follow-up work

The PRs that build the decisions, in order. Each is one PR; each moves its
**Target** lines above into today's description and closes its gaps. Paths
are under `native/mac/Sidebar/` unless they start with `native/`.

1. **The views test pins its own values (D7).** Built. Nothing on screen.
   Files: `native/mac/Tests/Views/main.swift`.
2. **Comments point at design.md anchors (D6).** Built. Nothing on screen. Files:
   the 16 files with a `.ts` pointer (`Views/CardView.swift`,
   `Views/ProjectsView.swift`, `Views/ChipsView.swift`, `Model/CardText.swift`,
   `Views/LaneView.swift`, `Model/BadgeInk.swift`, `Views/PanelView.swift`,
   `Model/Palette.swift`, `Model/ProjectText.swift`, `Views/TopView.swift`,
   `Views/Actions.swift`, `Views/BadgeTile.swift`, `Model/ChipFit.swift`,
   `Model/DropRule.swift`, `Views/Theme.swift`, `Model/Words.swift`) and the
   lines that lean on the pane or "the cockpit's".
3. **One type scale naming (D2).** Built. Nothing on screen. Files:
   `Views/Theme.swift`, `Views/CardView.swift`, `Views/ProjectsView.swift`,
   `Views/EditorSheet.swift`, `Views/Actions.swift`, `Views/PanelView.swift`.
4. **Radius rule (D3), with gap F's unused sizes.** Built. On screen: a dragged card
   and its gap outline keep the card's 12 corner instead of 6. Files:
   `Views/BadgeTile.swift`, `Views/CardView.swift`, `Views/LaneView.swift`,
   `Views/Theme.swift`, `Views/Drag.swift`, `Views/EditorSheet.swift`.
5. **Spacing literals named (gap C, no card).** Built. Nothing on screen. Files: the
   views listed on the audit page, mostly `Views/CardView.swift`,
   `Views/EditorSheet.swift`, `Views/PanelView.swift`, `Views/TopView.swift`
   and `Views/Theme.swift`.
6. **One count pill (D1).** Built. On screen: the unread number grows slightly wider
   and matches the lane count; the anchor badge draws the real unread badge.
   Files: `Views/CardView.swift`, `Views/LaneView.swift`, `Views/TopView.swift`,
   `Views/Theme.swift`.
7. **Views draw the core's colour (D8).** Built. On screen: the waiting count turns
   amber while every waiting card is an agent asking. Files:
   `Views/TopView.swift`, `Views/CardView.swift`, `Views/LaneView.swift`,
   `Model/CardText.swift`, `Model/ProjectText.swift`,
   `native/core/src/panel/mod.rs`, `native/core/src/panel/build.rs`.
8. **Red for failures, neutral for helper down (D5), with gap K's words.** Built. On
   screen: "Not sent" turns red; the "Cockpit isn't running" band loses its
   amber. Files: `Views/Actions.swift`, `Views/PanelView.swift`,
   `Model/Words.swift`, `Views/LaneView.swift`.
9. **Next in Ready's green (D9).** Built. On screen: the clay Next pill turns green.
   Files: `Views/TopView.swift`, `Model/Palette.swift`,
   `native/mac/Tests/Views/main.swift` (it checks `needsEdge` and
   `needsHover`), and the core, which picks Next's ink under grammar rule 1
   (`native/core/src/panel/`, adding the field to the panel model if it is
   missing).
10. **The size chip goes neutral (D10).** Built. On screen: "quick", "decide" and
    "review" turn grey. Files: `native/core/src/panel/build.rs` (`size_ink`
    and its test).
11. **One green for ready to merge (D11).** Built; `greenDeep` stays,
    only under the undrawn `greenChipEdge`. On screen: the lane's "ready to
    merge" line, a PR chip's "ready" and a dense row's ready PR number
    brighten to the merge green. Files: `native/core/src/pr_colors.rs`,
    `native/core/src/lane_entries.rs`, `native/core/src/panel/build.rs`
    tests, `native/mac/Tests/Views/main.swift`, and
    `native/core/src/theme.rs` and `Model/Palette.swift` if `greenDeep`
    goes.
12. **Faint and fade meanings (D12).** Built. On screen: fold chevrons and a quiet
    row's "+" darken a little; "No agent" takes the Idle grey; an empty
    lane's pill is no longer faint. Files: `native/core/src/status.rs`,
    `Views/LaneView.swift`, `Views/ProjectsView.swift`, `Views/Theme.swift`,
    `Model/ProjectText.swift`, `Model/CardText.swift`.
13. **Selection is the heading outline (D13).** Built. On screen: a selected anchor
    badge is outlined instead of shaded. Files: `Views/LaneView.swift`,
    `Model/Palette.swift` (`anchorSelected` goes),
    `native/mac/Tests/Views/main.swift`.
14. **Quiet words in the meta ink (D14).** Built. On screen: a compact card's quiet
    PR words and a card's title row age shift to the meta grey; hard to see.
    Files: `native/core/src/panel/build.rs`, `Views/CardView.swift`.
15. **Rename the "Waiting" status (D15).** On screen: a blue card with a
    running shell says the new word instead of "Waiting". Needs Jon to
    confirm the word ("Shell running" is a placeholder). Files:
    `native/core/src/words.rs`, `native/core/src/status.rs` tests.
16. **Unused colours go (gap F, no card).** Built: the sidebar's own
    colours, then `amberRowEdge` and `needsRowEdge` with the core's colour
    PR (follow-ups 7 to 14). Nothing on screen. Files:
    `Model/Palette.swift`, `native/core/src/theme.rs`,
    `native/mac/Tests/Views/main.swift`.
17. **Dark ground sampled (D4).** On screen: in dark mode the panel's ground
    and faint ink may shift slightly. Blocked on a dark-mode screenshot from
    Jon. Files: `Model/Palette.swift`, `native/mac/Tests/Views/main.swift`.
