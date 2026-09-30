// npm run setup, doctor and uninstall end to end, against a temp home with
// the checkout at ~/.config/cmux in it and fake cmux, git, gh, npm and
// plutil. Nothing here reads or writes the real home.

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { claudeFolders, entryCommand, legacy, wanted } from "../scripts/setup/claude-settings.ts";
import { setup, uninstall } from "../scripts/setup/commands.ts";
import {
  exitCode,
  findNodeCheck,
  HELPER_PATH,
  problemLines,
  report,
  runChecks,
} from "../scripts/setup/doctor-checks.ts";
import { pathsFor, type Runner, realRun } from "../scripts/setup/env.ts";
import { missingEntries } from "../scripts/setup/hooks-merge.ts";
import { type Answers, failed, fakeEnv, notFound, ok, tempHome } from "./support/setup-env.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function where() {
  const w = tempHome();
  homes.push(w.home);
  return w;
}

// A cmux with two repos open (one twice) and the home folder, and git that
// reports each folder as its own top level.
function cmuxWith(home: string): Answers {
  const workspaces = [`${home}/dev/app-one`, `${home}/dev/app-one`, home, `${home}/work/two`].map((d) => ({
    current_directory: d,
  }));
  return {
    "cmux --version": ok("cmux 0.65.1 (120) [abc]"),
    "cmux --json list-workspaces": ok(JSON.stringify({ workspaces })),
    [`git -C ${home}/dev/app-one`]: ok(`${home}/dev/app-one\n`),
    [`git -C ${home}/work/two`]: ok(`${home}/work/two\n`),
    [`git -C ${home} `]: failed("not a git repository"),
  };
}

const built = (repo: string): void => {
  for (const f of ["cockpit.js", "agents.js"]) writeFileSync(join(repo, "sidebars", f), "");
  writeFileSync(join(repo, "config", "last-build"), "");
};

describe("setup", () => {
  it("does the main steps on a fresh clone, seeding projects from cmux", async () => {
    const w = where();
    const f = fakeEnv(w, cmuxWith(w.home));
    assert.equal(await setup(f.env, ["--no-extras"]), 1); // exits 1: the fake npm run build writes nothing
    const p = pathsFor(w.home, w.repo, undefined);
    assert.deepEqual(JSON.parse(readFileSync(p.cmuxJson, "utf8")), JSON.parse(readFileSync(p.cmuxExample, "utf8")));
    const projects = JSON.parse(readFileSync(p.projects, "utf8"));
    assert.deepEqual(
      projects.map((x: { name: string }) => x.name),
      ["App One", "Two"],
    );
    for (const c of [
      "cmux reload-config",
      "npm run build",
      "cmux sidebar select cockpit",
      "cmux right-sidebar set custom agents",
    ]) {
      assert.ok(f.calls.includes(c), c);
    }
    assert.deepEqual(f.asked, []);
    assert.ok(f.out.some((l) => l.startsWith("✗ Build")));
  });

  it("is safe to rerun: it keeps an existing cmux.json and projects.json, and says so", async () => {
    const w = where();
    const p = pathsFor(w.home, w.repo, undefined);
    writeFileSync(p.cmuxJson, '{ "mine": true }');
    writeFileSync(p.projects, "[]");
    built(w.repo);
    const f = fakeEnv(w, cmuxWith(w.home));
    assert.equal(await setup(f.env, ["--no-extras"]), 0);
    assert.equal(readFileSync(p.cmuxJson, "utf8"), '{ "mine": true }');
    assert.equal(readFileSync(p.projects, "utf8"), "[]");
    assert.ok(f.out.some((l) => l.includes("no customSidebars block")));
    assert.ok(f.out.some((l) => l.includes("projects.json: already there")));
    assert.ok(!f.calls.some((c) => c.includes("list-workspaces")));
  });

  it("falls back to the example table with no workspaces or no cmux list", async () => {
    const w = where();
    const f = fakeEnv(w, { "cmux --version": ok("cmux 0.64.25"), "cmux --json list-workspaces": failed() });
    await setup(f.env, ["--no-extras"]);
    const p = pathsFor(w.home, w.repo, undefined);
    assert.equal(readFileSync(p.projects, "utf8"), readFileSync(p.projectsExample, "utf8"));
    assert.ok(f.out.some((l) => l.includes("copied the example")));
    assert.ok(f.out.some((l) => l.includes("lane highlight while dragging needs 0.65.0")));
  });

  it("stops before touching anything on old Node, no cmux, the wrong folder or no node_modules", async () => {
    const w = where();
    const p = pathsFor(w.home, w.repo, undefined);
    const stops = async (env: ReturnType<typeof fakeEnv>, why: RegExp) => {
      assert.equal(await setup(env.env, []), 1);
      assert.match(env.out.at(-1) ?? "", why);
      assert.equal(existsSync(p.cmuxJson), false);
    };
    await stops(fakeEnv(w, {}, { node: "22.1.0" }), /Node: 22\.1\.0 is older than 24\.2\.0/);
    await stops(fakeEnv(w, { "cmux --version": notFound }), /cmux: not found on PATH/);
    await stops(fakeEnv({ home: w.home, repo: join(w.home, "elsewhere") }), /cmux reads sidebars only from/);
    rmSync(p.nodeModules, { recursive: true });
    await stops(fakeEnv(w), /run npm ci first/);
    assert.equal(await setup(fakeEnv(w).env, ["--nope"]), 1);
  });

  it("adds every extra with --yes: helper, automations link and hooks", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    const f = fakeEnv(w, cmuxWith(w.home));
    await setup(f.env, ["--yes"]);
    assert.ok(f.calls.some((c) => c.endsWith("scripts/install-helper.ts")));
    assert.equal(readlinkSync(p.automationsLink), p.repoAutomations);
    assert.ok(f.calls.includes("cmux automation reload"));
    const settings = JSON.parse(readFileSync(p.claudeDefault.settings, "utf8"));
    assert.deepEqual(missingEntries(settings, wanted(), w.home), []);
    assert.equal(existsSync(p.claudeDefault.backup), false); // nothing to back up: there was no file
    assert.deepEqual(f.asked, []);
  });

  it("asks about each extra on a terminal, and adds none on no", async () => {
    const w = where();
    built(w.repo);
    const f = fakeEnv(w, cmuxWith(w.home), { interactive: true, reply: false });
    await setup(f.env, []);
    assert.deepEqual(f.asked, ["Add the helper?", "Add the automations?", "Add the hooks?"]);
    assert.equal(existsSync(pathsFor(w.home, w.repo, undefined).automationsLink), false);
  });

  it("lists the hooks it will add and asks again before writing, backing up first", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    writeFileSync(p.claudeDefault.settings, JSON.stringify({ model: "opus" }));
    writeFileSync(p.claudeDefault.backup, "an older backup");
    const f = fakeEnv(w, cmuxWith(w.home), { interactive: true, reply: true });
    await setup(f.env, []);
    assert.ok(f.asked.includes("  Write them to ~/.claude/settings.json?"));
    assert.ok(
      f.out.some((l) => l.includes("PostToolUse: node $HOME/.config/cmux/scripts/hooks/dispatch.ts PostToolUse")),
    );
    assert.equal(readFileSync(p.claudeDefault.backup, "utf8"), "an older backup");
    assert.equal(readFileSync(`${p.claudeDefault.backup}-20260928-140502`, "utf8"), JSON.stringify({ model: "opus" }));
    assert.equal(JSON.parse(readFileSync(p.claudeDefault.settings, "utf8")).model, "opus");
  });

  it("swaps old per-script hooks for the entry points, keeping the person's own hooks", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    const own = { hooks: [{ type: "command", command: "say done" }] };
    const old = (script: string) => ({ type: "command", command: `node ~/.config/cmux/scripts/hooks/${script}` });
    const published = { matcher: "Artifact|mcp__claude_ai_Claude_Docs__batch", hooks: [old("report-published.ts")] };
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    const stopBefore = [own, { hooks: [old("report-mention.ts"), old("report-move.ts")] }];
    writeFileSync(p.claudeDefault.settings, JSON.stringify({ hooks: { Stop: stopBefore, PostToolUse: [published] } }));
    const f = fakeEnv(w, cmuxWith(w.home));
    await setup(f.env, ["--hooks"]);
    const settings = JSON.parse(readFileSync(p.claudeDefault.settings, "utf8"));
    const stop = { hooks: [{ type: "command", command: entryCommand("Stop") }] };
    assert.deepEqual(settings.hooks.Stop, [own, stop]);
    assert.deepEqual(missingEntries(settings, wanted(), w.home), []);
    assert.equal(JSON.stringify(settings).includes("report-"), false);
    assert.ok(f.out.some((l) => l.includes("3 old per-script cockpit hooks come out")));
    assert.ok(f.out.some((l) => l.includes("took out 3 old per-script hooks")));
    assert.ok(existsSync(p.claudeDefault.backup));
  });

  it("refuses to touch settings that are not valid JSON", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    writeFileSync(p.claudeDefault.settings, "{ broken");
    const f = fakeEnv(w, cmuxWith(w.home));
    await setup(f.env, ["--hooks"]);
    assert.equal(readFileSync(p.claudeDefault.settings, "utf8"), "{ broken");
    assert.equal(existsSync(p.claudeDefault.backup), false);
    assert.ok(f.out.some((l) => l.includes("not valid JSON") && l.includes("Nothing changed")));
  });

  it("backs up a plain automations file of the repo's rules, but skips one with rules of its own", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.cmuxterm, { recursive: true });
    writeFileSync(p.automationsLink, JSON.stringify({ rules: [{ id: "mine" }] }));
    const f = fakeEnv(w, cmuxWith(w.home));
    await setup(f.env, ["--automations"]);
    assert.equal(lstatSync(p.automationsLink).isSymbolicLink(), false);
    assert.ok(f.out.some((l) => l.includes("rules the repo's does not: mine")));

    writeFileSync(p.automationsLink, JSON.stringify({ rules: [{ id: "pr-poll-turn" }] }));
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--automations"]);
    assert.equal(readlinkSync(p.automationsLink), p.repoAutomations);
    assert.match(readFileSync(p.automationsBackup, "utf8"), /pr-poll-turn/);
  });

  it("backs up a link to another file, and uninstall puts that link back", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.cmuxterm, { recursive: true });
    const theirs = join(w.home, "dotfiles.json");
    writeFileSync(theirs, JSON.stringify({ rules: [{ id: "pr-poll-turn" }] }));
    symlinkSync(theirs, p.automationsLink);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--automations"]);
    assert.equal(readlinkSync(p.automationsLink), p.repoAutomations);
    assert.equal(readlinkSync(p.automationsBackup), theirs);
    await uninstall(fakeEnv(w).env, ["--yes", "--automations"]);
    assert.equal(readlinkSync(p.automationsLink), theirs);
  });

  it("writes through a settings.json that is a link, keeping the link", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    const real = join(w.home, "real-settings.json");
    writeFileSync(real, "{}");
    symlinkSync(real, p.claudeDefault.settings);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--hooks"]);
    assert.ok(lstatSync(p.claudeDefault.settings).isSymbolicLink());
    assert.deepEqual(missingEntries(JSON.parse(readFileSync(real, "utf8")), wanted(), w.home), []);
  });

  it("writes nothing when settings.json changed while it waited on the question", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    writeFileSync(p.claudeDefault.settings, "{}");
    const f = fakeEnv(w, cmuxWith(w.home), { interactive: true, reply: true });
    const ask = f.env.ask;
    f.env.ask = async (q) => {
      if (q.includes("Write them")) writeFileSync(p.claudeDefault.settings, '{ "permissions": {} }');
      return ask(q);
    };
    await setup(f.env, []);
    assert.equal(readFileSync(p.claudeDefault.settings, "utf8"), '{ "permissions": {} }');
    assert.ok(f.out.some((l) => l.includes("changed while setup waited")));
  });
});

describe("doctor", () => {
  const fullAnswers = (home: string): Answers => ({
    ...cmuxWith(home),
    "gh --version": ok("gh version 2.80.0"),
    "gh auth status": ok(),
    "/usr/bin/plutil": ok("cmux-cockpit"),
    "/bin/sh": ok("/opt/homebrew/bin/node\n"),
  });

  it("ticks everything on a full install", async () => {
    const w = where();
    built(w.repo);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--yes"]);
    built(w.repo); // the fake npm run build writes nothing, and setup wrote projects.json since
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.helperApp, { recursive: true });
    writeFileSync(p.urlToken, "t");
    const checks = runChecks(fakeEnv(w, fullAnswers(w.home)).env);
    assert.deepEqual(
      checks.filter((c) => !c.ok).map((c) => c.label),
      [],
    );
    assert.equal(exitCode(checks), 0);
    assert.ok(report(checks).every((l) => l.startsWith("✓")));
  });

  it("crosses what is missing with a fix each, failing only on the required ones", () => {
    const w = where();
    const f = fakeEnv(w, { "gh --version": notFound, "cmux --version": ok("cmux 0.63.0"), "/bin/sh": failed() });
    const checks = runChecks(f.env);
    const failing = checks.filter((c) => !c.ok).map((c) => c.label);
    assert.deepEqual(failing, [
      "cmux",
      "GitHub CLI",
      "cmux.json",
      "Projects",
      "Build",
      "Helper app",
      "Automations",
      "Claude Code hooks",
      "Link token",
      "Node for the helper",
    ]);
    assert.ok(checks.every((c) => c.ok || c.fix !== ""));
    // Only the build is required among these; an old cmux is a warning.
    assert.equal(exitCode(checks), 1);
    assert.ok(report(checks).some((l) => l.startsWith("    fix: npm run build")));
  });

  it("fails when cmux is missing or Node is old, and on a stale build", () => {
    const w = where();
    built(w.repo);
    const src = join(w.repo, "src", "shared", "a.ts");
    const later = new Date(Date.now() + 60_000);
    utimesSync(src, later, later);
    const checks = runChecks(fakeEnv(w, { "cmux --version": notFound }, { node: "20.0.0" }).env);
    const byLabel = new Map(checks.map((c) => [c.label, c]));
    assert.equal(byLabel.get("Node")?.ok, false);
    assert.equal(byLabel.get("cmux")?.required, true);
    assert.match(byLabel.get("Build")?.detail ?? "", /older than src/);
    utimesSync(src, new Date(0), new Date(0));
    writeFileSync(pathsFor(w.home, w.repo, undefined).projects, "[]");
    utimesSync(pathsFor(w.home, w.repo, undefined).projects, later, later);
    const again = runChecks(fakeEnv(w).env).find((c) => c.label === "Build");
    assert.equal(again?.ok, false, "an edited projects.json needs a rebuild too");
    const mark = join(w.repo, "config", "last-build");
    utimesSync(mark, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    const fresh = runChecks(fakeEnv(w).env).find((c) => c.label === "Build");
    assert.equal(fresh?.ok, true, "a build that left the bundles unchanged still counts as fresh");
  });

  it("flags an old per-script hook left beside the entry points, naming the file", async () => {
    const w = where();
    built(w.repo);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--hooks"]);
    const p = pathsFor(w.home, w.repo, undefined);
    const settings = JSON.parse(readFileSync(p.claudeDefault.settings, "utf8"));
    settings.hooks.Stop.push({ hooks: [{ type: "command", command: legacy()[0] }] });
    writeFileSync(p.claudeDefault.settings, JSON.stringify(settings));
    const check = runChecks(fakeEnv(w).env).find((c) => c.label === "Claude Code hooks");
    assert.equal(check?.ok, false);
    assert.equal(check?.detail, "~/.claude/settings.json still has 1 old per-script hooks, so those scripts run twice");
    assert.equal(check?.fix, "npm run setup -- --hooks");
  });

  it("reads a broken cmux.json, projects.json and settings as crosses, not crashes", () => {
    const w = where();
    const p = pathsFor(w.home, w.repo, undefined);
    writeFileSync(p.cmuxJson, "{");
    writeFileSync(p.projects, '[{ "match": "/A" }]');
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    writeFileSync(p.claudeDefault.settings, "{");
    mkdirSync(p.helperApp, { recursive: true });
    const checks = new Map(runChecks(fakeEnv(w, { "/usr/bin/plutil": failed() }).env).map((c) => [c.label, c]));
    assert.match(checks.get("cmux.json")?.detail ?? "", /not valid JSON/);
    assert.match(checks.get("Projects")?.detail ?? "", /lowercase/);
    assert.match(checks.get("Claude Code hooks")?.detail ?? "", /^~\/\.claude\/settings\.json is not valid JSON/);
    assert.match(checks.get("Claude Code hooks")?.fix ?? "", /by hand/);
    assert.match(checks.get("Helper app")?.detail ?? "", /no cmux-cockpit:\/\/ scheme/);
  });

  it("shows the last refused and error lines of the state log from the past week", () => {
    const log = [
      "2026-09-01T10:00:00.000Z refused: old news",
      "2026-09-28T10:00:00.000Z ok key=ui.mode",
      "2026-09-28T10:00:01.000Z refused: bad token",
      "2026-09-28T10:00:02.000Z pr-poll error: gh failed",
      "2026-09-28T10:00:03.000Z find-node error: no node found",
      "2026-09-28T10:00:04.000Z pr-poll ok, 1 PRs",
    ].join("\n");
    const now = new Date("2026-09-28T12:00:00.000Z");
    assert.equal(problemLines(log, now).length, 3);
    assert.deepEqual(problemLines(log, now, 1), ["2026-09-28T10:00:03.000Z find-node error: no node found"]);
    assert.deepEqual(problemLines(log, new Date("2026-10-28T12:00:00.000Z")), []);

    const w = where();
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(join(w.home, "Library", "Logs"), { recursive: true });
    writeFileSync(p.stateLog, log);
    const check = runChecks(fakeEnv(w).env).find((c) => c.label === "State log");
    assert.equal(check?.ok, false);
    assert.match(check?.detail ?? "", /refused: bad token/);
    assert.doesNotMatch(check?.detail ?? "", /old news/);
  });
});

describe("uninstall", () => {
  it("takes out only the named extra", async () => {
    const w = where();
    built(w.repo);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--yes"]);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.helperApp, { recursive: true });
    await uninstall(fakeEnv(w).env, ["--yes", "--hooks"]);
    assert.ok(existsSync(p.helperApp));
    assert.ok(lstatSync(p.automationsLink).isSymbolicLink());
    const left = JSON.parse(readFileSync(p.claudeDefault.settings, "utf8"));
    assert.equal(missingEntries(left, wanted(), w.home).length, wanted().length);
  });

  it("takes out old per-script hooks along with the entry points", async () => {
    const w = where();
    built(w.repo);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--hooks"]);
    const p = pathsFor(w.home, w.repo, undefined);
    const settings = JSON.parse(readFileSync(p.claudeDefault.settings, "utf8"));
    settings.hooks.Stop.push({ matcher: "odd", hooks: legacy().map((command) => ({ type: "command", command })) });
    writeFileSync(p.claudeDefault.settings, JSON.stringify(settings));
    await uninstall(fakeEnv(w).env, ["--yes", "--hooks"]);
    assert.deepEqual(JSON.parse(readFileSync(p.claudeDefault.settings, "utf8")).hooks ?? {}, {});
  });

  it("takes out what setup added, restoring the old automations file, and keeps the clone", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.cmuxterm, { recursive: true });
    writeFileSync(p.automationsLink, JSON.stringify({ rules: [] }));
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFileSync(p.claudeDefault.settings, JSON.stringify(mine));
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--yes"]);
    mkdirSync(p.helperApp, { recursive: true });

    const f = fakeEnv(w);
    assert.equal(await uninstall(f.env, ["--yes"]), 0);
    assert.equal(existsSync(p.helperApp), false);
    assert.ok(f.calls.some((c) => c.includes("lsregister -u")));
    assert.equal(readFileSync(p.automationsLink, "utf8"), JSON.stringify({ rules: [] }));
    assert.deepEqual(JSON.parse(readFileSync(p.claudeDefault.settings, "utf8")), mine);
    assert.ok(existsSync(w.repo));
    assert.ok(f.out.some((l) => l.includes("rm -rf ~/.config/cmux")));
  });

  it("leaves a link that points elsewhere, and does nothing off a terminal without --yes", async () => {
    const w = where();
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.cmuxterm, { recursive: true });
    writeFileSync(join(w.home, "other.json"), "{}");
    symlinkSync(join(w.home, "other.json"), p.automationsLink);
    assert.equal(await uninstall(fakeEnv(w).env, []), 1);
    const f = fakeEnv(w, {}, { interactive: true, reply: true });
    assert.equal(await uninstall(f.env, []), 0);
    assert.equal(readlinkSync(p.automationsLink), join(w.home, "other.json"));
    assert.equal(await uninstall(fakeEnv(w).env, ["--bad"]), 1);
  });

  it("asks before each step on a terminal, and removes nothing on no", async () => {
    const w = where();
    built(w.repo);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--yes"]);
    const p = pathsFor(w.home, w.repo, undefined);
    mkdirSync(p.helperApp, { recursive: true });
    const f = fakeEnv(w, {}, { interactive: true, reply: false });
    await uninstall(f.env, []);
    assert.equal(f.asked.length, 3);
    assert.ok(existsSync(p.helperApp));
    assert.ok(lstatSync(p.automationsLink).isSymbolicLink());
  });
});

describe("Claude Code's config folders", () => {
  it("names CLAUDE_CONFIG_DIR's folder when that is an absolute path, else ~/.claude", () => {
    const home = "/Users/me";
    const set = pathsFor(home, "/r", "/Users/me/.claude-personal");
    assert.deepEqual(set.claudeConfigured, {
      dir: "/Users/me/.claude-personal",
      settings: "/Users/me/.claude-personal/settings.json",
      backup: "/Users/me/.claude-personal/settings.json.cmux-cockpit.bak",
      shown: "~/.claude-personal/settings.json",
    });
    assert.equal(set.claudeDefault.settings, "/Users/me/.claude/settings.json");
    assert.equal(pathsFor(home, "/r", "/etc/claude").claudeConfigured.shown, "/etc/claude/settings.json");
    for (const ignored of [undefined, "", "relative/claude"]) {
      const p = pathsFor(home, "/r", ignored);
      assert.deepEqual(p.claudeConfigured, p.claudeDefault);
      assert.equal(p.claudeConfigured.backup, "/Users/me/.claude/settings.json.cmux-cockpit.bak");
      assert.equal(p.claudeConfigured.shown, "~/.claude/settings.json");
    }
  });

  it("expands a leading ~ against home, and names a value it still ignores", () => {
    const home = "/Users/me";
    assert.equal(pathsFor(home, "/r", "~/.claude-personal").claudeConfigured.dir, "/Users/me/.claude-personal");
    assert.equal(pathsFor(home, "/r", "~").claudeConfigured.dir, "/Users/me");
    assert.equal(pathsFor(home, "/r", "~/.claude-personal").claudeConfigIgnored, undefined);
    for (const ignored of ["relative/claude", "~other/claude"]) {
      const p = pathsFor(home, "/r", ignored);
      assert.equal(p.claudeConfigured.settings, "/Users/me/.claude/settings.json");
      assert.equal(p.claudeConfigIgnored, ignored);
    }
    assert.equal(pathsFor(home, "/r", undefined).claudeConfigIgnored, undefined);
    assert.equal(pathsFor(home, "/r", "").claudeConfigIgnored, undefined);
  });

  it("shortens to ~ only under the real home, with no doubled slash", () => {
    const shown = (home: string, dir: string | undefined) => pathsFor(home, "/r", dir).claudeConfigured.shown;
    assert.equal(shown("/Users/me/", undefined), "~/.claude/settings.json");
    assert.equal(shown("/Users/me/", "/Users/me/p"), "~/p/settings.json");
    assert.equal(shown("/", undefined), "/.claude/settings.json");
    assert.equal(shown("/", "/etc/claude"), "/etc/claude/settings.json");
    assert.equal(shown("/Users/me", "/Users/meg/c"), "/Users/meg/c/settings.json");
  });

  it("counts ~/.claude once however it is spelled, and beside CLAUDE_CONFIG_DIR's only when it exists", () => {
    const w = where();
    const dirs = (dir: string | undefined) => claudeFolders(pathsFor(w.home, w.repo, dir)).map((f) => f.shown);
    const personal = join(w.home, ".claude-personal");
    assert.deepEqual(dirs(undefined), ["~/.claude/settings.json"]); // a fresh machine: made on write
    assert.deepEqual(dirs(personal), ["~/.claude-personal/settings.json"]);
    mkdirSync(join(w.home, ".claude"));
    assert.deepEqual(dirs(personal), ["~/.claude/settings.json", "~/.claude-personal/settings.json"]);
    assert.deepEqual(dirs(`${w.home}/.claude/`), ["~/.claude/settings.json"]);
    assert.deepEqual(dirs("~/.claude"), ["~/.claude/settings.json"]);
  });

  it("has setup and the doctor name an ignored CLAUDE_CONFIG_DIR", async () => {
    const w = where();
    built(w.repo);
    const line = 'CLAUDE_CONFIG_DIR is "relative/claude", not an absolute path, so it is ignored and ~/.claude is used';
    const f = fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: "relative/claude" });
    await setup(f.env, ["--hooks"]);
    assert.ok(f.out.includes(`  ! ${line}`), f.out.join("\n"));
    assert.ok(existsSync(pathsFor(w.home, w.repo, undefined).claudeDefault.settings));
    const doctor = report(runChecks(fakeEnv(w, {}, { claudeConfigDir: "relative/claude" }).env));
    assert.ok(doctor.includes(`    ! ${line}`), doctor.join("\n"));
    assert.ok(!report(runChecks(fakeEnv(w).env)).some((l) => l.includes("CLAUDE_CONFIG_DIR")));
  });

  it("has setup put the entry points in both folders, swapping out old hooks in each with its own backup", async () => {
    const w = where();
    built(w.repo);
    const dir = join(w.home, ".claude-personal");
    const p = pathsFor(w.home, w.repo, dir);
    const old = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacy()[5] }] }] } };
    for (const folder of [p.claudeDefault, p.claudeConfigured]) {
      mkdirSync(folder.dir, { recursive: true });
      writeFileSync(folder.settings, JSON.stringify(old));
    }
    const f = fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir });
    await setup(f.env, ["--hooks"]);
    for (const folder of [p.claudeDefault, p.claudeConfigured]) {
      const settings = JSON.parse(readFileSync(folder.settings, "utf8"));
      assert.deepEqual(missingEntries(settings, wanted(), w.home), [], folder.shown);
      assert.equal(JSON.stringify(settings).includes("report-rename"), false, folder.shown);
      assert.equal(readFileSync(folder.backup, "utf8"), JSON.stringify(old), folder.shown);
      assert.ok(f.out.some((l) => l.includes(`These go into ${folder.shown},`)));
    }

    const again = fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir });
    await setup(again.env, ["--hooks"]);
    assert.equal(again.out.filter((l) => l.includes("every entry point is already in")).length, 2);
  });

  it("carries on to the next folder when one holds a file it cannot read", async () => {
    const w = where();
    built(w.repo);
    const dir = join(w.home, ".claude-personal");
    const p = pathsFor(w.home, w.repo, dir);
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    writeFileSync(p.claudeDefault.settings, "{ broken");
    await setup(fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir }).env, ["--hooks"]);
    assert.equal(readFileSync(p.claudeDefault.settings, "utf8"), "{ broken");
    const settings = JSON.parse(readFileSync(p.claudeConfigured.settings, "utf8"));
    assert.deepEqual(missingEntries(settings, wanted(), w.home), []);
  });

  it("has the doctor check both folders and name the one missing its entry points", async () => {
    const w = where();
    built(w.repo);
    const dir = join(w.home, ".claude-personal");
    const p = pathsFor(w.home, w.repo, dir);
    const hooks = () =>
      runChecks(fakeEnv(w, {}, { claudeConfigDir: dir }).env).find((c) => c.label === "Claude Code hooks");

    await setup(fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir }).env, ["--hooks"]);
    assert.equal(hooks()?.detail, "entry points in ~/.claude-personal/settings.json");

    // ~/.claude turns up later (Claude Code run without the variable): the doctor wants it too.
    mkdirSync(p.claudeDefault.dir);
    assert.equal(hooks()?.ok, false);
    assert.equal(hooks()?.detail, "no ~/.claude/settings.json");

    const settings = JSON.parse(readFileSync(p.claudeConfigured.settings, "utf8"));
    delete settings.hooks.UserPromptSubmit;
    writeFileSync(p.claudeDefault.settings, JSON.stringify(settings));
    assert.equal(hooks()?.detail, "~/.claude/settings.json is missing 1 entry points");
    assert.equal(hooks()?.fix, "npm run setup -- --hooks");

    await setup(fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir }).env, ["--hooks"]);
    assert.equal(hooks()?.ok, true);
    assert.equal(hooks()?.detail, "entry points in ~/.claude/settings.json and ~/.claude-personal/settings.json");
  });

  it("has uninstall take the hooks out of both folders", async () => {
    const w = where();
    built(w.repo);
    const dir = join(w.home, ".claude-personal");
    const p = pathsFor(w.home, w.repo, dir);
    mkdirSync(p.claudeDefault.dir, { recursive: true });
    await setup(fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir }).env, ["--hooks"]);
    const f = fakeEnv(w, {}, { claudeConfigDir: dir });
    await uninstall(f.env, ["--yes", "--hooks"]);
    for (const folder of [p.claudeDefault, p.claudeConfigured]) {
      const left = JSON.parse(readFileSync(folder.settings, "utf8"));
      assert.equal(missingEntries(left, wanted(), w.home).length, wanted().length, folder.shown);
      assert.ok(f.out.includes(`✓ removed ${wanted().length} hooks from ${folder.shown}`));
    }
  });
});

describe("doctor's Node for the helper", () => {
  // The real find-node.sh through the real runner, in a temp home, with the
  // Homebrew fallbacks pointed at nothing so the runner's own node cannot answer.
  const noFixed: Runner = (cmd, args, opts = {}) =>
    realRun(cmd, args, { ...opts, env: { ...(opts.env ?? {}), CMUX_COCKPIT_FIXED_NODES: "/nonexistent/node" } });
  const repo = join(import.meta.dirname, "..");

  it("looks only where the helper looks, not on this shell's PATH, which has node", () => {
    const w = where();
    // With this shell's PATH the same home does find a node, so the cross is the PATH's doing.
    const onPath = realRun("/bin/sh", [join(repo, "scripts", "find-node.sh")], {
      env: { HOME: w.home, PATH: process.env.PATH ?? "", CMUX_COCKPIT_FIXED_NODES: "/nonexistent/node" },
    });
    assert.equal(onPath.status, 0);
    const check = findNodeCheck({ ...fakeEnv(w).env, repo, run: noFixed }, pathsFor(w.home, repo, undefined));
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, /helper's PATH/);
  });

  it("names the node the helper would use, such as volta's under that home", () => {
    const w = where();
    const volta = join(w.home, ".volta", "bin");
    mkdirSync(volta, { recursive: true });
    writeFileSync(join(volta, "node"), "#!/bin/sh\n", { mode: 0o755 });
    const check = findNodeCheck({ ...fakeEnv(w).env, repo, run: noFixed }, pathsFor(w.home, repo, undefined));
    assert.equal(check.ok, true, check.detail);
    assert.equal(check.detail, join(volta, "node"));
  });

  it("hands find-node.sh only HOME and the helper's PATH", () => {
    const w = where();
    const seen: (Record<string, string> | undefined)[] = [];
    const run: Runner = (_c, _a, opts = {}) => {
      seen.push(opts.env);
      return ok("/usr/bin/node");
    };
    findNodeCheck({ ...fakeEnv(w).env, run }, pathsFor(w.home, w.repo, undefined));
    assert.deepEqual(seen, [{ HOME: w.home, PATH: HELPER_PATH }]);
  });
});
