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
import { wanted } from "../scripts/setup/claude-settings.ts";
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
};

describe("setup", () => {
  it("does the main steps on a fresh clone, seeding projects from cmux", async () => {
    const w = where();
    const f = fakeEnv(w, cmuxWith(w.home));
    assert.equal(await setup(f.env, ["--no-extras"]), 1); // exits 1: the fake npm run build writes nothing
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
    assert.equal(readFileSync(p.projects, "utf8"), readFileSync(p.projectsExample, "utf8"));
    assert.ok(f.out.some((l) => l.includes("copied the example")));
    assert.ok(f.out.some((l) => l.includes("lane highlight while dragging needs 0.65.0")));
  });

  it("stops before touching anything on old Node, no cmux, the wrong folder or no node_modules", async () => {
    const w = where();
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
    const f = fakeEnv(w, cmuxWith(w.home));
    await setup(f.env, ["--yes"]);
    assert.ok(f.calls.some((c) => c.endsWith("scripts/install-helper.ts")));
    assert.equal(readlinkSync(p.automationsLink), p.repoAutomations);
    assert.ok(f.calls.includes("cmux automation reload"));
    const settings = JSON.parse(readFileSync(p.claudeSettings, "utf8"));
    assert.deepEqual(missingEntries(settings, wanted(), w.home), []);
    assert.equal(existsSync(p.claudeBackup), false); // nothing to back up: there was no file
    assert.deepEqual(f.asked, []);
  });

  it("asks about each extra on a terminal, and adds none on no", async () => {
    const w = where();
    built(w.repo);
    const f = fakeEnv(w, cmuxWith(w.home), { interactive: true, reply: false });
    await setup(f.env, []);
    assert.deepEqual(f.asked, ["Add the helper?", "Add the automations?", "Add the hooks?"]);
    assert.equal(existsSync(pathsFor(w.home, w.repo).automationsLink), false);
  });

  it("lists the hooks it will add and asks again before writing, backing up first", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.claudeDir, { recursive: true });
    writeFileSync(p.claudeSettings, JSON.stringify({ model: "opus" }));
    writeFileSync(p.claudeBackup, "an older backup");
    const f = fakeEnv(w, cmuxWith(w.home), { interactive: true, reply: true });
    await setup(f.env, []);
    assert.ok(f.asked.includes("  Write them?"));
    assert.ok(f.out.some((l) => l.includes("PostToolUse [Bash]: node $HOME/.config/cmux/scripts/hooks/report-pr.ts")));
    assert.equal(readFileSync(p.claudeBackup, "utf8"), "an older backup");
    assert.equal(readFileSync(`${p.claudeBackup}-20260928-140502`, "utf8"), JSON.stringify({ model: "opus" }));
    assert.equal(JSON.parse(readFileSync(p.claudeSettings, "utf8")).model, "opus");
  });

  it("refuses to touch settings that are not valid JSON", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.claudeDir, { recursive: true });
    writeFileSync(p.claudeSettings, "{ broken");
    const f = fakeEnv(w, cmuxWith(w.home));
    await setup(f.env, ["--hooks"]);
    assert.equal(readFileSync(p.claudeSettings, "utf8"), "{ broken");
    assert.equal(existsSync(p.claudeBackup), false);
    assert.ok(f.out.some((l) => l.includes("not valid JSON") && l.includes("Nothing changed")));
  });

  it("backs up a plain automations file of the repo's rules, but skips one with rules of its own", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.claudeDir, { recursive: true });
    const real = join(w.home, "real-settings.json");
    writeFileSync(real, "{}");
    symlinkSync(real, p.claudeSettings);
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--hooks"]);
    assert.ok(lstatSync(p.claudeSettings).isSymbolicLink());
    assert.deepEqual(missingEntries(JSON.parse(readFileSync(real, "utf8")), wanted(), w.home), []);
  });

  it("writes nothing when settings.json changed while it waited on the question", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.claudeDir, { recursive: true });
    writeFileSync(p.claudeSettings, "{}");
    const f = fakeEnv(w, cmuxWith(w.home), { interactive: true, reply: true });
    const ask = f.env.ask;
    f.env.ask = async (q) => {
      if (q.includes("Write them")) writeFileSync(p.claudeSettings, '{ "permissions": {} }');
      return ask(q);
    };
    await setup(f.env, []);
    assert.equal(readFileSync(p.claudeSettings, "utf8"), '{ "permissions": {} }');
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
    const p = pathsFor(w.home, w.repo);
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
    writeFileSync(pathsFor(w.home, w.repo).projects, "[]");
    utimesSync(pathsFor(w.home, w.repo).projects, later, later);
    const again = runChecks(fakeEnv(w).env).find((c) => c.label === "Build");
    assert.equal(again?.ok, false, "an edited projects.json needs a rebuild too");
  });

  it("reads a broken cmux.json, projects.json and settings as crosses, not crashes", () => {
    const w = where();
    const p = pathsFor(w.home, w.repo);
    writeFileSync(p.cmuxJson, "{");
    writeFileSync(p.projects, '[{ "match": "/A" }]');
    mkdirSync(p.claudeDir, { recursive: true });
    writeFileSync(p.claudeSettings, "{");
    mkdirSync(p.helperApp, { recursive: true });
    const checks = new Map(runChecks(fakeEnv(w, { "/usr/bin/plutil": failed() }).env).map((c) => [c.label, c]));
    assert.match(checks.get("cmux.json")?.detail ?? "", /not valid JSON/);
    assert.match(checks.get("Projects")?.detail ?? "", /lowercase/);
    assert.match(checks.get("Claude Code hooks")?.detail ?? "", /not valid JSON/);
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
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.helperApp, { recursive: true });
    await uninstall(fakeEnv(w).env, ["--yes", "--hooks"]);
    assert.ok(existsSync(p.helperApp));
    assert.ok(lstatSync(p.automationsLink).isSymbolicLink());
    assert.equal(missingEntries(JSON.parse(readFileSync(p.claudeSettings, "utf8")), wanted(), w.home).length, 9);
  });

  it("takes out what setup added, restoring the old automations file, and keeps the clone", async () => {
    const w = where();
    built(w.repo);
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.cmuxterm, { recursive: true });
    writeFileSync(p.automationsLink, JSON.stringify({ rules: [] }));
    mkdirSync(p.claudeDir, { recursive: true });
    const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFileSync(p.claudeSettings, JSON.stringify(mine));
    await setup(fakeEnv(w, cmuxWith(w.home)).env, ["--yes"]);
    mkdirSync(p.helperApp, { recursive: true });

    const f = fakeEnv(w);
    assert.equal(await uninstall(f.env, ["--yes"]), 0);
    assert.equal(existsSync(p.helperApp), false);
    assert.ok(f.calls.some((c) => c.includes("lsregister -u")));
    assert.equal(readFileSync(p.automationsLink, "utf8"), JSON.stringify({ rules: [] }));
    assert.deepEqual(JSON.parse(readFileSync(p.claudeSettings, "utf8")), mine);
    assert.ok(existsSync(w.repo));
    assert.ok(f.out.some((l) => l.includes("rm -rf ~/.config/cmux")));
  });

  it("leaves a link that points elsewhere, and does nothing off a terminal without --yes", async () => {
    const w = where();
    const p = pathsFor(w.home, w.repo);
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
    const p = pathsFor(w.home, w.repo);
    mkdirSync(p.helperApp, { recursive: true });
    const f = fakeEnv(w, {}, { interactive: true, reply: false });
    await uninstall(f.env, []);
    assert.equal(f.asked.length, 3);
    assert.ok(existsSync(p.helperApp));
    assert.ok(lstatSync(p.automationsLink).isSymbolicLink());
  });
});

describe("Claude Code's config folder", () => {
  it("is CLAUDE_CONFIG_DIR when that is an absolute path, else ~/.claude", () => {
    const home = "/Users/me";
    const set = pathsFor(home, "/r", "/Users/me/.claude-personal");
    assert.equal(set.claudeDir, "/Users/me/.claude-personal");
    assert.equal(set.claudeSettings, "/Users/me/.claude-personal/settings.json");
    assert.equal(set.claudeBackup, "/Users/me/.claude-personal/settings.json.cmux-cockpit.bak");
    assert.equal(set.claudeSettingsShown, "~/.claude-personal/settings.json");
    assert.equal(pathsFor(home, "/r", "/etc/claude").claudeSettingsShown, "/etc/claude/settings.json");
    for (const ignored of [undefined, "", "relative/claude"]) {
      const p = pathsFor(home, "/r", ignored);
      assert.equal(p.claudeSettings, "/Users/me/.claude/settings.json");
      assert.equal(p.claudeBackup, "/Users/me/.claude/settings.json.cmux-cockpit.bak");
      assert.equal(p.claudeSettingsShown, "~/.claude/settings.json");
    }
  });

  it("is where setup --hooks writes and the doctor and uninstall look", async () => {
    const w = where();
    built(w.repo);
    const dir = join(w.home, ".claude-personal");
    const p = pathsFor(w.home, w.repo, dir);
    const f = fakeEnv(w, cmuxWith(w.home), { claudeConfigDir: dir });
    await setup(f.env, ["--hooks"]);
    assert.deepEqual(missingEntries(JSON.parse(readFileSync(p.claudeSettings, "utf8")), wanted(), w.home), []);
    assert.equal(existsSync(pathsFor(w.home, w.repo).claudeSettings), false); // ~/.claude untouched
    assert.ok(f.out.some((l) => l.includes(`These go into ${p.claudeSettings}`)));

    const hooks = (env: ReturnType<typeof fakeEnv>) => runChecks(env.env).find((c) => c.label === "Claude Code hooks");
    assert.equal(
      hooks(fakeEnv(w, {}, { claudeConfigDir: dir }))?.detail,
      "all present in ~/.claude-personal/settings.json",
    );
    assert.equal(hooks(fakeEnv(w))?.detail, "no ~/.claude/settings.json"); // without the variable, the other file

    await uninstall(fakeEnv(w, {}, { claudeConfigDir: dir }).env, ["--yes", "--hooks"]);
    const left = JSON.parse(readFileSync(p.claudeSettings, "utf8"));
    assert.equal(missingEntries(left, wanted(), w.home).length, wanted().length);
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
    const check = findNodeCheck({ ...fakeEnv(w).env, repo, run: noFixed }, pathsFor(w.home, repo));
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, /helper's PATH/);
  });

  it("names the node the helper would use, such as volta's under that home", () => {
    const w = where();
    const volta = join(w.home, ".volta", "bin");
    mkdirSync(volta, { recursive: true });
    writeFileSync(join(volta, "node"), "#!/bin/sh\n", { mode: 0o755 });
    const check = findNodeCheck({ ...fakeEnv(w).env, repo, run: noFixed }, pathsFor(w.home, repo));
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
    findNodeCheck({ ...fakeEnv(w).env, run }, pathsFor(w.home, w.repo));
    assert.deepEqual(seen, [{ HOME: w.home, PATH: HELPER_PATH }]);
  });
});
