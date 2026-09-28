// The colours and SF Symbols a project steps through, apart from
// projects.ts so a script can import them: projects.ts reads the table the
// build injects, which exists only inside a bundled sidebar. The sidebar's
// "New project from this folder" and npm run setup's seeded table both
// take from these, so there is one set, not two.

/** Colours a sidebar-made project steps through. glyphColor keeps its icon readable on any of them. */
export const PROJECT_COLORS = [
  "#D97757",
  "#6A9BCC",
  "#788C5D",
  "#C2A83E",
  "#9B6FB0",
  "#CC6B8E",
  "#4F9C94",
  "#8A7F72",
] as const;

/** SF Symbols a sidebar-made project steps through; a new one starts on the first. */
export const PROJECT_ICONS = [
  "folder.fill",
  "star.fill",
  "cube.fill",
  "leaf.fill",
  "music.note",
  "hammer.fill",
  "book.fill",
  "flame.fill",
  "bolt.fill",
  "globe",
  "paintbrush.fill",
  "gearshape.fill",
] as const;
