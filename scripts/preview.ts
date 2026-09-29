// npm run preview: every snapshot scene as a PNG, for judging a design
// without reloading cmux.
//
// The snapshot tests build each scene from fixture data; with PREVIEW_DIR
// set they also save it as an HTML page (test/support/html.ts). Headless
// Chrome then loads each page once to read its laid-out height and again to
// screenshot it at that height, at Retina scale. preview/index.html shows
// them side by side. The layout is flexbox standing in for SwiftUI, so it
// is close, not exact: check the real sidebar after reload.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve("preview");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!existsSync(CHROME)) {
  console.error(`No Chrome at ${CHROME}. Install Google Chrome, or set CHROME to a Chrome or Chromium binary.`);
  process.exit(1);
}

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
execFileSync(process.execPath, ["--test", "test/snapshot-*.test.ts"], {
  env: { ...process.env, PREVIEW_DIR: DIR },
  stdio: "inherit",
});

const chrome = (args: string[]): string =>
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

// The page's width from its body style, and its height from the title it
// sets once laid out.
function size(page: string): { width: number; height: number } {
  const dom = chrome(["--dump-dom", `file://${page}`]);
  const width = Number(/<body style="[^"]*width:(\d+)px/.exec(dom)?.[1] ?? 320);
  const height = Number(/<title>(\d+)<\/title>/.exec(dom)?.[1] ?? 800);
  return { width, height };
}

const scenes = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();

for (const scene of scenes) {
  const page = `${DIR}/${scene}.html`;
  const { width, height } = size(page);
  chrome([
    "--force-device-scale-factor=2",
    `--window-size=${width},${height}`,
    `--screenshot=${DIR}/${scene}.png`,
    `file://${page}`,
  ]);
  console.log(`preview/${scene}.png  ${width}x${height}`);
}

const cells = scenes
  .map((s) => `<figure><figcaption>${s}</figcaption><img src="${s}.png" alt="${s}"></figure>`)
  .join("");
writeFileSync(
  `${DIR}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Sidebar preview</title><style>body{margin:24px;font:13px -apple-system,sans-serif;background:#E9E6DC}main{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}figure{margin:0}figcaption{margin-bottom:8px;color:#5E5D59}img{width:50%;min-width:0;box-shadow:0 0 0 1px #0002;border-radius:6px}figure{display:flex;flex-direction:column}figure img{width:auto;zoom:.5}</style><main>${cells}</main>\n`,
);
console.log("preview/index.html");
