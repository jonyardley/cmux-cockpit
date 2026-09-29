// npm run pr-visuals [-- --pr <n>] [-- --no-push]: before and after
// pictures of every preview scene this branch changes, for the PR's
// "What changed on screen" section.
//
// It renders the preview scenes twice: the commit where this branch forked
// from origin/main, from a `git archive` copy in a temporary folder
// (running that commit's own preview script, with this checkout's
// node_modules), then this checkout. Chrome draws the same page to the same
// bytes, so a scene whose PNG differs is a scene that changed. Those pairs
// go to the `pr-images` branch, one folder per PR number, written through
// a throwaway index so no checkout moves. The printed markdown links each
// image at the commit that holds it, so a later run for the same PR leaves
// older descriptions showing what they showed. Pushing needs a clean tree
// with HEAD pushed; --no-push leaves the pairs in preview/pr-visuals/.
//
// The branch holds only images, but its first commit's parent is the
// repo's root commit: the pre-push hook refuses anything that does not
// descend from it, so an orphan branch could never be pushed.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const BRANCH = "pr-images";

export interface Change {
  scene: string;
  before: boolean;
  after: boolean;
}

// Scenes whose PNG differs between the two renders, sorted by name. A scene
// only one side draws is a change too: new on the branch, or gone from it.
export function changedScenes(before: Map<string, Buffer>, after: Map<string, Buffer>): Change[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((scene) => {
    const b = before.get(scene);
    const a = after.get(scene);
    if (b && a && b.equals(a)) return [];
    return [{ scene, before: b !== undefined, after: a !== undefined }];
  });
}

// A PNG's width in pixels, from its header: the IHDR chunk always comes
// first, with the width at byte 16.
export function pngWidth(png: Buffer): number {
  return png.readUInt32BE(16);
}

export interface Image {
  url: string;
  // The width to show it at: the screenshots are at Retina scale, so half
  // their pixels is their size in points.
  width: number;
}

function cell(image: Image | undefined, missing: string): string {
  return image ? `<img src="${image.url}" width="${image.width}" alt="">` : missing;
}

// The table for the PR description, or the words the template asks for
// when nothing moved.
export function markdown(rows: { scene: string; before?: Image | undefined; after?: Image | undefined }[]): string {
  if (rows.length === 0) return "No visual changes in the preview scenes.";
  const lines = rows.map(
    (r) => `| ${r.scene} | ${cell(r.before, "not on main")} | ${cell(r.after, "removed on this branch")} |`,
  );
  return ["| Scene | Before | After |", "| --- | --- | --- |", ...lines].join("\n");
}

const git = (args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } }).trim();

const gh = (args: string[]): string => execFileSync("gh", args, { cwd: ROOT, encoding: "utf8" }).trim();

function pngs(dir: string): Map<string, Buffer> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
  return new Map(files.map((f) => [f.replace(/\.png$/, ""), readFileSync(join(dir, f))]));
}

// Runs a preview script with its test output on stderr, so a snapshot
// failure shows its report while stdout stays the markdown alone.
function preview(cwd: string): string {
  execFileSync(process.execPath, ["scripts/preview.ts"], { cwd, stdio: ["ignore", process.stderr, "inherit"] });
  return join(cwd, "preview");
}

// The scenes where this branch forked from main, drawn by that commit's own
// preview script. The fork point, not main's tip, so work merged to main
// since then never shows as this branch's change.
function renderBase(tmp: string): string {
  git(["fetch", "--quiet", "origin", "main"]);
  const base = git(["merge-base", "origin/main", "HEAD"]);
  const dir = join(tmp, "base");
  mkdirSync(dir);
  execFileSync("sh", ["-c", `git archive ${base} | tar -x -C "${dir}"`], { cwd: ROOT, stdio: "inherit" });
  if (!existsSync(join(dir, "scripts", "preview.ts"))) {
    throw new Error(`The fork point ${base.slice(0, 7)} has no scripts/preview.ts to draw the before pictures with.`);
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return preview(dir);
}

// The PR's number and repo, checked before any rendering. The pictures are
// published as the PR's, so they must be of what the PR holds: a clean
// tree, with HEAD pushed.
function target(flag: string | undefined): { pr: string; repo: string } {
  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error("Uncommitted changes would end up in the PR's pictures. Commit or stash them, or pass --no-push.");
  }
  if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", "@{upstream}"])) {
    throw new Error("HEAD is not what the PR's branch holds on GitHub. Push first, or pass --no-push.");
  }
  const pr = flag ?? gh(["pr", "view", "--json", "number", "--jq", ".number"]);
  if (!/^\d+$/.test(pr)) throw new Error(`Not a PR number: "${pr}". Open the PR first, or pass --pr <n>.`);
  return { pr, repo: gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]) };
}

// The pr-images tip to build on, or the repo's root commit when the branch
// does not exist yet. Asked with ls-remote first, so a failed fetch fails
// here rather than passing for a missing branch.
function parent(): { commit: string; tree: string | null } {
  if (git(["ls-remote", "--heads", "origin", BRANCH]) === "") {
    return { commit: git(["rev-list", "--max-parents=0", "origin/main"]), tree: null };
  }
  git(["fetch", "--quiet", "origin", `refs/heads/${BRANCH}`]);
  return { commit: git(["rev-parse", "FETCH_HEAD"]), tree: git(["rev-parse", "FETCH_HEAD^{tree}"]) };
}

// Replaces the PR's folder on pr-images with `files` (published name to
// local path), pushes, and returns the commit that holds them. A rerun with
// the same pictures adds no commit, so the branch only grows when they move.
function publish(pr: string, files: Map<string, string>, tmp: string): string {
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  const base = parent();
  git(base.tree ? ["read-tree", base.tree] : ["read-tree", "--empty"], env);
  git(["rm", "--cached", "-r", "--quiet", "--ignore-unmatch", `${pr}/`], env);
  for (const [name, path] of files) {
    const blob = git(["hash-object", "-w", path]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${pr}/${name}`], env);
  }
  const tree = git(["write-tree"], env);
  if (tree === base.tree) return base.commit;
  const commit = git(["commit-tree", tree, "-p", base.commit, "-m", `Before and after images for #${pr}`]);
  git(["push", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`]);
  return commit;
}

// --no-push: the pairs go to the gitignored preview/pr-visuals/, where the
// markdown's local paths point.
function keep(files: Map<string, string>): (name: string) => string {
  const out = join(ROOT, "preview", "pr-visuals");
  mkdirSync(out, { recursive: true });
  for (const [name, path] of files) copyFileSync(path, join(out, name));
  return (name) => join(out, name);
}

function run(tmp: string, flag: string | undefined, push: boolean): string {
  const to = push ? target(flag) : null;
  const beforeDir = renderBase(tmp);
  const afterDir = preview(ROOT);
  const before = pngs(beforeDir);
  const after = pngs(afterDir);
  const changes = changedScenes(before, after);

  const files = new Map<string, string>();
  for (const c of changes) {
    if (c.before) files.set(`${c.scene}-before.png`, join(beforeDir, `${c.scene}.png`));
    if (c.after) files.set(`${c.scene}-after.png`, join(afterDir, `${c.scene}.png`));
  }
  if (changes.length === 0) return markdown([]);

  let url: (name: string) => string;
  if (to) {
    const commit = publish(to.pr, files, tmp);
    url = (name) => `https://raw.githubusercontent.com/${to.repo}/${commit}/${to.pr}/${name}`;
  } else {
    url = keep(files);
  }
  const image = (side: "before" | "after", shots: Map<string, Buffer>, scene: string): Image | undefined => {
    const png = shots.get(scene);
    return png ? { url: url(`${scene}-${side}.png`), width: pngWidth(png) / 2 } : undefined;
  };
  return markdown(
    changes.map((c) => ({
      scene: c.scene,
      before: image("before", before, c.scene),
      after: image("after", after, c.scene),
    })),
  );
}

function main(): void {
  const { values } = parseArgs({
    options: { pr: { type: "string" }, "no-push": { type: "boolean", default: false } },
    strict: true,
  });
  const tmp = mkdtempSync(join(tmpdir(), "pr-visuals-"));
  try {
    console.log(run(tmp, values.pr, !values["no-push"]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
