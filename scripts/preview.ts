// npm run preview: every snapshot scene as a PNG, for judging a design
// without reloading cmux.
//
// The snapshot tests build each scene from fixture data; with PREVIEW_DIR
// set they also save it as an HTML page (test/support/html.ts). Headless
// Chrome then loads each page once to read its laid-out height and again to
// screenshot it at that height, at Retina scale, all scenes at once. preview/index.html shows
// them side by side. The layout is flexbox standing in for SwiftUI, so it
// is close, not exact: check the real sidebar after reload.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Every path hangs off the repo root, so running the script from any other
// directory never touches a preview/ folder there.
const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "preview");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!existsSync(CHROME)) {
  console.error(`No Chrome at ${CHROME}. Install Google Chrome, or set CHROME to a Chrome or Chromium binary.`);
  process.exit(1);
}

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
execFileSync(process.execPath, ["--test", "test/snapshot-*.test.ts"], {
  cwd: ROOT,
  env: { ...process.env, PREVIEW_DIR: DIR },
  stdio: "inherit",
});

const run = promisify(execFile);
const chrome = async (args: string[]): Promise<string> => {
  const { stdout } = await run(
    CHROME,
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
};

// The page's width from its body style, and its height from the title it
// sets once laid out. A page that never sets either is a broken page, so
// stop rather than screenshot it at a guessed size.
async function size(url: string): Promise<{ width: number; height: number }> {
  const dom = await chrome(["--dump-dom", url]);
  const width = /<body style="[^"]*width:(\d+)px/.exec(dom)?.[1];
  const height = /<title>(\d+)<\/title>/.exec(dom)?.[1];
  if (width === undefined || height === undefined) {
    throw new Error(`Could not measure ${url}: no body width or laid-out height in the page.`);
  }
  return { width: Number(width), height: Number(height) };
}

// Each scene still measures, then screenshots; the scenes run side by side.
async function shoot(scene: string): Promise<string> {
  const url = pathToFileURL(join(DIR, `${scene}.html`)).href;
  const { width, height } = await size(url);
  await chrome([
    "--force-device-scale-factor=2",
    `--window-size=${width},${height}`,
    `--screenshot=${join(DIR, `${scene}.png`)}`,
    url,
  ]);
  return `preview/${scene}.png  ${width}x${height}`;
}

const scenes = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();

for (const line of await Promise.all(scenes.map(shoot))) console.log(line);

const cells = scenes
  .map((s) => `<figure><figcaption>${s}</figcaption><img src="${s}.png" alt="${s}"></figure>`)
  .join("");
writeFileSync(
  join(DIR, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Sidebar preview</title><style>body{margin:24px;font:13px -apple-system,sans-serif;background:#E9E6DC}main{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}figure{margin:0;display:flex;flex-direction:column}figcaption{margin-bottom:8px;color:#5E5D59}img{box-shadow:0 0 0 1px #0002;border-radius:6px;zoom:.5}</style><main>${cells}</main>\n`,
);
console.log("preview/index.html");
