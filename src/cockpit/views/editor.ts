// The project editor card (src/cockpit/edit.ts), shown under a project's
// header or quiet row: the project's tile beside its name, then colour,
// icon with its search, and folder, then Remove, Cancel and Done. Making a
// new project, it opens on the folder instead, with the open folders that
// have no project under it, and the name follows the folder.

import { glyphColor } from "../../shared/contrast.ts";
import { tildeHome } from "../../shared/home.ts";
import { PROJECT_COLORS } from "../../shared/projects.ts";
import { projectBadge, ring, sectionTitle, when } from "../../shared/ui.ts";
import {
  addSuggested,
  cancelSearch,
  closeEditor,
  draftProblem,
  draftSpec,
  ICONS_PER_ROW,
  iconRows,
  iconSearch,
  isNewDraft,
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
} from "../edit.ts";
import { folderSuggestions } from "../model.ts";
import { C } from "../theme.ts";

const SWATCHES_PER_ROW = 8;

const label = (text: string): View => sectionTitle(text.toUpperCase(), C.secondary);

const glyph = (): string => glyphColor(draftSpec().color, C.text);

// The field draws no box of its own, so it sits in a ring. Its text is read
// once, so a rebuild mid-edit keeps what was typed.
interface FieldKeys {
  font?: number;
  onCancel?: () => void;
}

// Escape closes, unless the field says what else it does. No onSubmit: cmux
// sends it when the field loses focus too, so a tap on a colour or Done
// would land after the editor had already saved and closed. Done saves.
function field(
  text: string,
  placeholder: string,
  autofocus: boolean,
  onEdit: (t: string) => void,
  { font = 12.5, onCancel = closeEditor }: FieldKeys = {},
): View {
  const input = TextField(text, { placeholder, autofocus, onEdit, onCancel })
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

// A new project's name, read from the draft as the folder is typed: it
// follows the folder, and Edit project renames it later.
function newNameRow(): View {
  return HStack({ spacing: 10 }, [
    tile(),
    VStack({ spacing: 3, alignment: "leading" }, [
      label("New project"),
      Text(() => draftSpec().name || "Named after its folder")
        .font(13)
        .weight("semibold")
        .color(() => (draftSpec().name ? C.text : C.tertiary))
        .lineLimit(1),
    ]),
  ]);
}

// One open folder with no project, as a row: a tap makes it a project.
function suggestion(dir: string): View {
  const row = HStack({ spacing: 6 }, [
    Image("plus").font(10).weight("semibold").color(C.secondary),
    Text(tildeHome(dir)).font(11.5).monospaced().color(C.secondary).lineLimit(1).truncation("middle"),
    Spacer({ minLength: 0 }),
  ])
    .paddingHorizontal(6)
    .paddingVertical(3)
    .frame({ maxWidth: "infinity" });
  return ring(row, C.chipFace, C.chipEdge, 1, 6, { hover: { face: C.linkHover } }).onTap(() => addSuggested(dir));
}

function suggestions(): View {
  return when(
    "new-suggestions",
    () => folderSuggestions().length > 0,
    () =>
      VStack({ spacing: 4, alignment: "leading" }, [
        Text("Or one you have open").font(11).color(C.tertiary).paddingTop(8),
        ForEach({ items: folderSuggestions, key: (dir) => dir }, (dir) => suggestion(dir())),
      ]),
  );
}

function actions(): View {
  const fresh = isNewDraft();
  return HStack({ spacing: 6 }, [
    ...(fresh ? [] : [Text(removeLabel).font(12).color(C.redText).onTap(removeTapped)]),
    Spacer({ minLength: 4 }),
    Text("Cancel").font(12).color(C.secondary).paddingHorizontal(8).paddingVertical(4).onTap(closeEditor),
    Text(fresh ? "Add" : "Done")
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

// Editing, the folder comes last with the folders it matches; making a
// project, it comes first, focused, with the open folders under it.
function folderRows(k: string, root: string): View[] {
  if (isNewDraft()) return [field(root, "~/dev/folder", true, setDraftFolder), suggestions()];
  return [
    field(root, "~/Dev/folder, for the +", false, setDraftFolder),
    Text(matchesLine(k)).font(11).color(C.tertiary).lineLimit(2).paddingTop(4),
  ];
}

export function projectEditor(k: string): View {
  const spec = draftSpec();
  const folder = [label("Folder").paddingTop(14).paddingBottom(5), ...folderRows(k, spec.root ?? "")];
  const fresh = isNewDraft();
  const body = VStack({ spacing: 0, alignment: "leading" }, [
    ...(fresh ? [newNameRow(), ...folder] : [nameRow(spec.name)]),
    label("Colour").paddingTop(14).paddingBottom(7),
    VStack({ spacing: 8 }, swatches()),
    label("Icon").paddingTop(14).paddingBottom(6),
    iconPicker(),
    VStack({ spacing: 0 }, [
      field(iconSearch(), "Search icons", false, setIconSearch, {
        font: 12,
        onCancel: cancelSearch,
      }),
    ]).paddingTop(8),
    ...(fresh ? [] : folder),
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
