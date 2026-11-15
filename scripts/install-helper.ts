// Builds the cmux-cockpit:// URL handler helper app (docs/state-loop.md):
// fills helper/CmuxCockpit.applescript with the repo root and the scripts
// it runs, compiles it with osacompile, tags it as the URL handler, and
// registers it with Launch Services. Node is not baked in: the app finds
// it at tap time with scripts/find-node.sh, so a Node upgrade needs no
// reinstall.
//
//   npm run helper                                    # ~/Applications, registers
//   npm run helper -- --out <dir>                      # a different install dir
//   npm run helper -- --out <dir> --no-register         # skip lsregister (CI, tests)
//
// Every subprocess call uses an absolute path and an argument array, never a
// shell, so nothing here is exposed to PATH lookup or shell interpolation.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "io.github.cmux-cockpit";
const SCHEME = "cmux-cockpit";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

interface Args {
  /** Null means the default, ~/Applications. */
  out: string | null;
  register: boolean;
}

// Unknown or malformed flags are refused: a mistyped --out must not fall
// through to replacing the installed app.
function parseArgs(argv: readonly string[]): Args | string {
  let out: string | null = null;
  let register = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-register") register = false;
    else if (arg === "--out" && argv[i + 1]) out = argv[++i] ?? null;
    else return `unknown or incomplete argument ${JSON.stringify(arg)}`;
  }
  return { out, register };
}

function warnAboutSpike(): void {
  const spike = join(homedir(), "Applications", "CmuxCockpitSpike.app");
  if (existsSync(spike)) {
    console.warn(
      `install-helper: ${spike} exists and claims the ${SCHEME}:// scheme from an earlier spike. ` +
        "Delete it so Launch Services routes the scheme here instead.",
    );
  }
}

// cmux loads the sidebars from the main checkout, so a handler built from a
// worktree would write state and rebuild bundles cmux never reads.
const MAIN_CHECKOUT = join(homedir(), ".config", "cmux");

// The paths land inside AppleScript string literals, so escape what would end one.
const asLiteral = (s: string): string => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** The helper's AppleScript with this checkout's paths filled in. Exported for testing. */
export function filledScript(root: string): string {
  const template = readFileSync(join(root, "helper", "CmuxCockpit.applescript"), "utf8");
  return template
    .replaceAll("__ROOT__", asLiteral(root))
    .replaceAll("__FINDER__", "scripts/find-node.sh")
    .replaceAll("__SCRIPT__", "scripts/state-set.ts");
}

// A dict wrapped in the array plutil -insert wants for a one-element CFBundleURLTypes.
function urlTypesXml(): string {
  return (
    "<array><dict>" +
    `<key>CFBundleURLName</key><string>${BUNDLE_ID}</string>` +
    `<key>CFBundleURLSchemes</key><array><string>${SCHEME}</string></array>` +
    "</dict></array>"
  );
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`install-helper: ${args}`);
    return 1;
  }
  const root = join(import.meta.dirname, "..");
  if (root !== MAIN_CHECKOUT && args.out === null) {
    console.error(`install-helper: run from ${root}, but cmux reads ${MAIN_CHECKOUT}. Run it there, or pass --out.`);
    return 1;
  }
  const { register } = args;
  const out = args.out ?? join(homedir(), "Applications");
  warnAboutSpike();

  // Built beside the target (same volume, so the final rename is atomic) and
  // swapped in only once every step has succeeded, so a failed install keeps
  // the working app.
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(out, ".CmuxCockpit-build-"));
  const filledPath = join(scratch, "CmuxCockpit.applescript");
  writeFileSync(filledPath, filledScript(root));

  const built = join(scratch, "CmuxCockpit.app");
  const plistPath = join(built, "Contents", "Info.plist");
  const appPath = join(out, "CmuxCockpit.app");
  try {
    execFileSync("/usr/bin/osacompile", ["-o", built, filledPath]);
    execFileSync("/usr/bin/plutil", ["-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, plistPath]);
    execFileSync("/usr/bin/plutil", ["-insert", "CFBundleURLTypes", "-xml", urlTypesXml(), plistPath]);
    execFileSync("/usr/bin/plutil", ["-insert", "LSUIElement", "-bool", "true", plistPath]);
    execFileSync("/usr/bin/codesign", ["-f", "-s", "-", built]);
    rmSync(appPath, { recursive: true, force: true });
    renameSync(built, appPath);
    if (register) execFileSync(LSREGISTER, ["-f", appPath]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`install-helper: built ${appPath}${register ? " and registered it" : " (not registered)"}`);
  return 0;
}

if (import.meta.main) process.exit(main());
