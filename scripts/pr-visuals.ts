// npm run pr-visuals [-- --pr <n>] [-- --no-push]: before and after
// pictures of every preview scene this branch changes, for the PR's
// "What changed on screen" section.
//
// It renders the preview scenes twice: origin/main from a `git archive`
// copy in a temporary folder (running main's own preview script, so the
// "before" is what main draws), then this checkout. Chrome draws the same
// page to the same bytes, so a scene whose PNG differs is a scene that
// changed. Those pairs go to the `pr-images` branch, one folder per PR
// number, written through a throwaway index so no checkout moves. The
// printed markdown links each image at the commit that holds it, so a
// later run for the same PR leaves older descriptions showing what they
// showed.
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
  if (rows.length === 0) return "No snapshot changes.";
  const lines = rows.map(
    (r) => `| ${r.scene} | ${cell(r.before, "not on main")} | ${cell(r.after, "removed on this branch")} |`,
  );
  return ["| Scene | Before | After |", "| --- | --- | --- |", ...lines].join("\n");
}

const git = (args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } }).trim();

function pngs(dir: string): Map<string, Buffer> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
  return new Map(files.map((f) => [f.replace(/\.png$/, ""), readFileSync(join(dir, f))]));
}

// origin/main's scenes, drawn by origin/main's own preview script.
function renderMain(tmp: string): string {
  git(["fetch", "--quiet", "origin", "main"]);
  const dir = join(tmp, "main");
  mkdirSync(dir);
  execFileSync("sh", ["-c", `git archive origin/main | tar -x -C "${dir}"`], { cwd: ROOT, stdio: "inherit" });
  if (!existsSync(join(dir, "scripts", "preview.ts"))) {
    throw new Error("origin/main has no scripts/preview.ts to draw the before pictures with.");
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  execFileSync(process.execPath, ["scripts/preview.ts"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  return join(dir, "preview");
}

function renderBranch(): string {
  execFileSync(process.execPath, ["scripts/preview.ts"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  return join(ROOT, "preview");
}

function prNumber(flag: string | undefined): string {
  const n =
    flag ??
    execFileSync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^\d+$/.test(n)) throw new Error(`Not a PR number: "${n}". Open the PR first, or pass --pr <n>.`);
  return n;
}

// The pr-images tip to build on, or the repo's root commit when the branch
// does not exist yet.
function parent(): { commit: string; tree: string | null } {
  try {
    git(["fetch", "--quiet", "origin", `refs/heads/${BRANCH}`]);
    return { commit: git(["rev-parse", "FETCH_HEAD"]), tree: git(["rev-parse", "FETCH_HEAD^{tree}"]) };
  } catch {
    return { commit: git(["rev-list", "--max-parents=0", "origin/main"]), tree: null };
  }
}

// Replaces the PR's folder on pr-images with `files` (published name to
// local path), pushes, and returns the new commit.
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
  const commit = git(["commit-tree", tree, "-p", base.commit, "-m", `Before and after images for #${pr}`]);
  git(["push", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`]);
  return commit;
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--pr");
  const flag = at === -1 ? undefined : args[at + 1];
  const push = !args.includes("--no-push");

  const tmp = mkdtempSync(join(tmpdir(), "pr-visuals-"));
  const beforeDir = renderMain(tmp);
  const afterDir = renderBranch();
  const before = pngs(beforeDir);
  const after = pngs(afterDir);
  const changes = changedScenes(before, after);

  const files = new Map<string, string>();
  for (const c of changes) {
    if (c.before) files.set(`${c.scene}-before.png`, join(beforeDir, `${c.scene}.png`));
    if (c.after) files.set(`${c.scene}-after.png`, join(afterDir, `${c.scene}.png`));
  }

  let url = (name: string): string => join(tmp, "out", name);
  if (changes.length > 0 && push) {
    const pr = prNumber(flag);
    const repo = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const commit = publish(pr, files, tmp);
    url = (name) => `https://raw.githubusercontent.com/${repo}/${commit}/${pr}/${name}`;
  } else if (changes.length > 0) {
    // --no-push: keep the pairs where the markdown's local paths point.
    mkdirSync(join(tmp, "out"));
    for (const [name, path] of files) copyFileSync(path, join(tmp, "out", name));
  }

  const image = (side: "before" | "after", shots: Map<string, Buffer>, scene: string): Image | undefined => {
    const png = shots.get(scene);
    return png ? { url: url(`${scene}-${side}.png`), width: pngWidth(png) / 2 } : undefined;
  };
  const rows = changes.map((c) => ({
    scene: c.scene,
    before: image("before", before, c.scene),
    after: image("after", after, c.scene),
  }));
  console.log(markdown(rows));
  if (push) rmSync(tmp, { recursive: true, force: true });
}

if (import.meta.main) main();
