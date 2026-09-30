// The home folder, baked in by build.ts, so a folder typed as "~/dev/app"
// becomes the absolute path a project matches on (the sidebar has no other
// way to learn it). Read through typeof, so a test or bundle that never
// defines it simply has none.

declare const __HOME__: string | undefined;
const HOME: string = typeof __HOME__ === "string" ? __HOME__.replace(/\/+$/, "") : "";

const underHome = (path: string): boolean => path === "~" || path.startsWith("~/");

/** `path` trimmed, with a leading "~" expanded; null when it starts with "~" and no home is known. */
export function expandHome(path: string, home: string = HOME): string | null {
  const p = path.trim();
  if (!underHome(p)) return p;
  return home ? home + p.slice(1) : null;
}

/** Whether `dir` is the home folder itself, which would swallow every session as one project. */
export function isHome(dir: string | undefined, home: string = HOME): boolean {
  return !!home && String(dir ?? "").replace(/\/+$/, "") === home;
}

/** An absolute path under home as "~/...", for showing; any other path as it is. */
export function tildeHome(path: string, home: string = HOME): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
