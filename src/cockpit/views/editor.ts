// The project editor card (src/cockpit/edit.ts), shown under a project's
// header or quiet row: the project's tile beside its name, then colour,
// icon with its search, and folder, then Remove, Cancel and Done.

import { glyphColor } from "../../shared/contrast.ts";
import { PROJECT_COLORS } from "../../shared/projects.ts";
import { projectBadge, ring, sectionTitle, when } from "../../shared/ui.ts";
import {
  cancelSearch,
  closeEditor,
  draftProblem,
  draftSpec,
  ICONS_PER_ROW,
  iconRows,
  iconSearch,
  matchesLine,
  removeLabel,
  removeTapped,
  rowsOf,
  saveDraft,
  searchNote,
  setDraftColor,
  setDraftFolder,
  setDraftIcon,
  setDraftName,
  setIconSearch,
  submitSearch,
} from "../edit.ts";
import { C } from "../theme.ts";

const SWATCHES_PER_ROW = 8;

const label = (text: string): View => sectionTitle(text.toUpperCase(), C.secondary);

const glyph = (): string => glyphColor(draftSpec().color, C.text);

// The field draws no box of its own, so it sits in a ring. Its text is read
// once, so a rebuild mid-edit keeps what was typed.
interface FieldKeys {
  font?: number;
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
}

// Return saves and Escape closes, unless the field says what else they do.
function field(
  text: string,
  placeholder: string,
  autofocus: boolean,
  onEdit: (t: string) => void,
  { font = 12.5, onSubmit = saveDraft, onCancel = closeEditor }: FieldKeys = {},
): View {
  const input = TextField(text, { placeholder, autofocus, onEdit, onSubmit, onCancel })
    .font(font)
    .paddingHorizontal(8)
    .paddingVertical(5);
  return ring(input, C.card, C.fieldEdge, 1, 7);
}

// The project as it will look: its colour and icon, following the draft.
const tile = (): View => projectBadge(() => ({ match: "", ...draftSpec() }), 36, 17, 10);

function nameRow(name: string): View {
  return HStack({ spacing: 10 }, [
    tile(),
    VStack({ spacing: 3, alignment: "leading" }, [label("Name"), field(name, "Project name", true, setDraftName)]),
  ]);
}

// Each slot takes an equal share of the row, as a grid column would.
const slot = (view: View): View => view.frame({ maxWidth: "infinity" });

// A white gap and then an ink ring round the chosen colour.
function swatch(color: string): View {
  const on = () => draftSpec().color.toLowerCase() === color.toLowerCase();
  const dot = Circle({ size: 18 }).fill(color).padding(2);
  return slot(
    ring(dot, C.card, () => (on() ? C.select : C.card), 1.5, 12, { hug: true }).onTap(() => setDraftColor(color)),
  );
}

const swatches = (): View[] =>
  rowsOf(PROJECT_COLORS, SWATCHES_PER_ROW).map((row) => HStack({ spacing: 0 }, row.map(swatch)));

// The chosen icon sits on the project's colour, the rest are quiet. The
// tap is on the tile's shape, so the whole tile takes it, not only the glyph.
function iconChoice(icon: string): View {
  const on = () => draftSpec().icon === icon;
  return slot(
    ZStack({}, [
      RoundedRectangle({ cornerRadius: 7 }).fill(() => (on() ? draftSpec().color : C.card)),
      Image(icon)
        .font(13)
        .color(() => (on() ? glyph() : C.secondary)),
    ])
      .frame({ width: 26, height: 26 })
      .cornerRadius(7)
      .hoverBackground(() => (on() ? draftSpec().color : C.hover))
      .onTap(() => setDraftIcon(icon)),
  );
}

// An empty slot, so a short row keeps to the columns of a full one.
const gap = (): View => slot(Rectangle().fill("clear").frame({ width: 26, height: 26 }));

// Rows follow the search as it is typed. A row is keyed by its place, its
// icons by name and its empty slots by place, so each keeps one kind.
function iconPicker(): View {
  const rows = () => iconRows(draftSpec().icon, iconSearch()).map((icons, i) => ({ id: `icons-${i}`, icons }));
  return VStack({ spacing: 4, alignment: "leading" }, [
    ForEach({ items: rows, key: (r) => r.id }, (row) =>
      HStack({ spacing: 0 }, [
        ForEach({ items: () => row().icons, key: (icon) => icon }, (icon) => iconChoice(icon())),
        ForEach(
          {
            items: () => Array.from({ length: ICONS_PER_ROW - row().icons.length }, (_, i) => `gap-${i}`),
            key: (g) => g,
          },
          gap,
        ),
      ]),
    ),
    when(
      "icon-search-note",
      () => searchNote(iconSearch()) !== "",
      () =>
        Text(() => searchNote(iconSearch()))
          .font(11)
          .color(C.tertiary),
    ),
  ]);
}

function actions(): View {
  return HStack({ spacing: 6 }, [
    Text(removeLabel).font(12).color(C.redText).onTap(removeTapped),
    Spacer({ minLength: 4 }),
    Text("Cancel").font(12).color(C.secondary).paddingHorizontal(8).paddingVertical(4).onTap(closeEditor),
    Text("Done")
      .font(12)
      .weight("semibold")
      .color(C.onBadge)
      .paddingHorizontal(12)
      .paddingVertical(4)
      .background(() => (draftProblem() ? C.faint : C.select))
      .cornerRadius(8)
      .onTap(saveDraft),
  ]);
}

export function projectEditor(k: string): View {
  const spec = draftSpec();
  const body = VStack({ spacing: 0, alignment: "leading" }, [
    nameRow(spec.name),
    label("Colour").paddingTop(14).paddingBottom(7),
    VStack({ spacing: 8 }, swatches()),
    label("Icon").paddingTop(14).paddingBottom(6),
    iconPicker(),
    VStack({ spacing: 0 }, [
      field(iconSearch(), "Search icons", false, setIconSearch, {
        font: 12,
        onSubmit: submitSearch,
        onCancel: cancelSearch,
      }),
    ]).paddingTop(8),
    label("Folder").paddingTop(14).paddingBottom(5),
    field(spec.root ?? "", "~/Dev/folder, for the +", false, setDraftFolder),
    Text(matchesLine(k)).font(11).color(C.tertiary).lineLimit(2).paddingTop(4),
    Text(() => draftProblem() ?? "")
      .font(11)
      .color(C.clayText)
      .opacity(() => (draftProblem() ? 1 : 0))
      .paddingTop(6),
    actions().paddingTop(10),
  ])
    .paddingHorizontal(12)
    .paddingTop(14)
    .paddingBottom(12);
  return VStack({ spacing: 0 }, [ring(body, C.card, C.selectEdge, 1.5, 12)]).paddingBottom(6);
}
