// A folder typed as "~/dev/app" in the project table becomes the absolute
// path a project matches on: build.ts expands it against the home folder,
// since a sidebar has no filesystem access to do it at runtime.

const underHome = (path: string): boolean => path === "~" || path.startsWith("~/");

/** `path` trimmed, with a leading "~" expanded; null when it starts with "~" and no home is known. */
export function expandHome(path: string, home: string): string | null {
  const p = path.trim();
  if (!underHome(p)) return p;
  return home ? home + p.slice(1) : null;
}
