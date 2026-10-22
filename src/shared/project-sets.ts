// The colours and SF Symbols a project steps through, apart from
// projects.ts so a script can import them: projects.ts reads the table the
// build injects, which exists only inside a bundled sidebar. npm run
// setup's seeded table takes from these.

/** Colours a seeded project steps through. glyphColor keeps its icon readable on any of them. */
export const PROJECT_COLORS = [
  "#D97757",
  "#6A9BCC",
  "#788C5D",
  "#C2A83E",
  "#9B6FB0",
  "#CC6B8E",
  "#4F9C94",
  "#8A7F72",
  "#B8503C",
  "#E0934A",
  "#98AE4E",
  "#3E7FA8",
  "#6C74C9",
  "#8E4F7E",
  "#5D8A6A",
  "#5E6670",
] as const;

/** The editor's common icons, one row of eight, and the SF Symbols a seeded project steps through (symbols.ts lists the rest). */
export const PROJECT_ICONS = [
  "folder.fill",
  "chevron.left.forwardslash.chevron.right",
  "terminal.fill",
  "music.note",
  "house.fill",
  "bag.fill",
  "star.fill",
  "bolt.fill",
] as const;
