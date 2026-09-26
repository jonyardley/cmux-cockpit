// Builds the cmux-cockpit:// URL handler helper app (docs/state-loop.md):
// fills helper/CmuxCockpit.applescript with this machine's node path and
// repo root, compiles it with osacompile, tags it as the URL handler, and
// registers it with Launch Services.
//
//   npm run helper                                    # ~/Applications, registers
//   npm run helper -- --out <dir>                      # a different install dir
//   npm run helper -- --out <dir> --no-register         # skip lsregister (CI, tests)
//
// Every subprocess call uses an absolute path and an argument array, never a
// shell, so nothing here is exposed to PATH lookup or shell interpolation.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "com.jonyardley.cmux-cockpit";
const SCHEME = "cmux-cockpit";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

interface Args {
  out: string;
  register: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let out = join(homedir(), "Applications");
  let register = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? out;
    else if (argv[i] === "--no-register") register = false;
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
function warnAboutWorktree(root: string): void {
  const main = join(homedir(), ".config", "cmux");
  if (root !== main) console.warn(`install-helper: built from ${root}, but cmux reads ${main}. Run it there.`);
}

// The paths land inside AppleScript string literals, so escape what would end one.
const asLiteral = (s: string): string => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

function filledScript(root: string): string {
  const template = readFileSync(join(root, "helper", "CmuxCockpit.applescript"), "utf8");
  return template
    .replaceAll("__NODE__", asLiteral(process.execPath))
    .replaceAll("__ROOT__", asLiteral(root))
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
  const { out, register } = parseArgs(process.argv.slice(2));
  const root = join(import.meta.dirname, "..");
  warnAboutSpike();
  warnAboutWorktree(root);

  const scratch = mkdtempSync(join(tmpdir(), "cmux-cockpit-helper-"));
  const filledPath = join(scratch, "CmuxCockpit.applescript");
  writeFileSync(filledPath, filledScript(root));

  const appPath = join(out, "CmuxCockpit.app");
  const plistPath = join(appPath, "Contents", "Info.plist");
  try {
    // A fresh bundle each time, so a reinstall does not trip over the keys added below.
    rmSync(appPath, { recursive: true, force: true });
    execFileSync("/usr/bin/osacompile", ["-o", appPath, filledPath]);
    execFileSync("/usr/bin/plutil", ["-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, plistPath]);
    execFileSync("/usr/bin/plutil", ["-insert", "CFBundleURLTypes", "-xml", urlTypesXml(), plistPath]);
    execFileSync("/usr/bin/plutil", ["-insert", "LSUIElement", "-bool", "true", plistPath]);
    execFileSync("/usr/bin/codesign", ["-f", "-s", "-", appPath]);
    if (register) execFileSync(LSREGISTER, ["-f", appPath]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`install-helper: built ${appPath}${register ? " and registered it" : " (not registered)"}`);
  return 0;
}

process.exit(main());
