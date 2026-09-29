// The project editor strip (src/cockpit/edit.ts), shown under a project's
// header or quiet row: name, colour, icon and folder, then Remove and Done.

import { PROJECT_COLORS } from "../../shared/projects.ts";
import { ring } from "../../shared/ui.ts";
import {
  closeEditor,
  draftProblem,
  draftSpec,
  iconRows,
  matchesLine,
  removeLabel,
  removeTapped,
  saveDraft,
  setDraftColor,
  setDraftFolder,
  setDraftIcon,
  setDraftName,
} from "../edit.ts";
import { C } from "../theme.ts";

const label = (text: string): View => Text(text).font(10).weight("medium").color(C.faint);

// The field draws no box of its own, so it sits in a ring. Its text is read
// once, from the draft, so a rebuild mid-edit keeps what was typed.
function field(text: string, placeholder: string, autofocus: boolean, onEdit: (t: string) => void): View {
  const input = TextField(text, { placeholder, autofocus, onEdit, onSubmit: saveDraft, onCancel: closeEditor })
    .font(12)
    .paddingHorizontal(7)
    .paddingVertical(4);
  return ring(input, C.card, C.fieldEdge, 1, 6);
}

function swatch(color: string): View {
  const on = () => draftSpec().color.toLowerCase() === color.toLowerCase();
  const dot = Circle({ size: 14 }).fill(color);
  return ring(dot, C.card, () => (on() ? C.select : C.card), 2, 10, { hug: true }).onTap(() => setDraftColor(color));
}

function iconChoice(icon: string): View {
  const on = () => draftSpec().icon === icon;
  return Image(icon)
    .font(11)
    .color(() => (on() ? C.onBadge : C.secondary))
    .frame({ width: 22, height: 22 })
    .background(() => (on() ? C.select : C.ground))
    .cornerRadius(5)
    .onTap(() => setDraftIcon(icon));
}

// Rows of at most six, so the icons fit the sidebar's width.
const iconPicker = (current: string): View[] =>
  iconRows(current).map((row) => HStack({ spacing: 4 }, row.map(iconChoice)));

function actions(): View {
  return HStack({ spacing: 10 }, [
    Text(removeLabel).font(11).color(C.redText).onTap(removeTapped),
    Spacer({ minLength: 4 }),
    Text("Cancel").font(11).color(C.secondary).onTap(closeEditor),
    Text("Done")
      .font(11)
      .weight("semibold")
      .color(C.onBadge)
      .paddingHorizontal(10)
      .paddingVertical(3)
      .background(() => (draftProblem() ? C.faint : C.select))
      .cornerRadius(6)
      .onTap(saveDraft),
  ]);
}

export function projectEditor(k: string): View {
  const spec = draftSpec();
  const body = VStack({ spacing: 6, alignment: "leading" }, [
    label("NAME"),
    field(spec.name, "Project name", true, setDraftName),
    label("COLOUR"),
    HStack({ spacing: 3 }, PROJECT_COLORS.map(swatch)),
    label("ICON"),
    ...iconPicker(spec.icon),
    label("FOLDER"),
    field(spec.root ?? "", "~/Dev/folder, for the +", false, setDraftFolder),
    Text(matchesLine(k)).font(10).color(C.faint).lineLimit(2),
    Text(() => draftProblem() ?? "")
      .font(11)
      .color(C.clayText)
      .opacity(() => (draftProblem() ? 1 : 0)),
    actions(),
  ]).padding(10);
  return VStack({ spacing: 0 }, [ring(body, C.card, C.select, 1.5, 10)]).paddingBottom(6);
}
