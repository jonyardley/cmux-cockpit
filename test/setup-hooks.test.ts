// Adding and removing the cockpit's Claude Code hooks (scripts/setup/hooks-merge.ts),
// the entry points claude-settings.ts derives from scripts/hooks/routes.ts,
// and the quickstart's by-hand block matching them.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROUTES } from "../scripts/hooks/routes.ts";
import { entryCommand, hooksState, legacy, wanted } from "../scripts/setup/claude-settings.ts";
import {
  addEntries,
  canonical,
  describe as describeEntry,
  hooksShapeError,
  missingEntries,
  parseSettings,
  removeCommands,
} from "../scripts/setup/hooks-merge.ts";

const HOME = "/Users/someone";
const WANTED = wanted();
const COMMANDS = WANTED.map((e) => e.command);
const LEGACY = legacy();
const HOOKS = join(import.meta.dirname, "..", "scripts", "hooks");
const hook = (command: string): { type: string; command: string } => ({ type: "command", command });
const routedScripts = (): Set<string> => new Set(Object.values(ROUTES).flatMap((rs) => rs.map((r) => r.script)));

const theirs = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
};

describe("the entry points", () => {
  it("are the quickstart's by-hand JSON block, so the doc cannot drift", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "quickstart.md"), "utf8");
    const section = doc.slice(doc.indexOf("### Claude Code hooks"));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    assert.ok(block, "the quickstart has a json block under Claude Code hooks");
    assert.deepEqual(JSON.parse(block), addEntries({}, WANTED));
  });

  it("are one per routed event, each running dispatch.ts with that event and no matcher", () => {
    assert.deepEqual(
      WANTED.map((e) => e.event),
      Object.keys(ROUTES),
    );
    for (const e of WANTED) {
      assert.equal(e.matcher, null);
      assert.equal(e.command, `node $HOME/.config/cmux/scripts/hooks/dispatch.ts ${e.event}`);
      assert.deepEqual(e.hook, hook(e.command));
    }
  });

  it("route every report-*.ts script there is, and only scripts that exist", () => {
    const onDisk = readdirSync(HOOKS).filter((f) => /^report-[a-z]+\.ts$/.test(f));
    assert.deepEqual([...routedScripts()].sort(), onDisk.sort());
    for (const s of routedScripts()) assert.ok(existsSync(join(HOOKS, s)), s);
  });

  it("replace every script setup once added one by one", () => {
    const old = new Set(LEGACY.map((c) => /report-[a-z]+\.ts$/.exec(c)?.[0]));
    for (const s of routedScripts()) assert.ok(old.has(s), `${s} is not in the legacy list`);
    assert.ok(old.has("report-mention.ts"));
  });
});

describe("parseSettings", () => {
  it("refuses text that is not JSON, or not an object", () => {
    assert.match(parseSettings("{ nope").ok ? "" : "bad", /bad/);
    const r = parseSettings("[1]");
    assert.equal(r.ok ? "" : r.error, "not a JSON object");
  });

  it("refuses hooks of a shape it does not know, naming where", () => {
    const err = (hooks: unknown): string | null => hooksShapeError(hooks);
    assert.equal(err(undefined), null);
    assert.match(err([]) ?? "", /"hooks" is not an object/);
    assert.match(err({ Stop: {} }) ?? "", /hooks.Stop" is not a list/);
    assert.match(err({ Stop: [1] }) ?? "", /Stop\[0\]" is not an object/);
    assert.match(err({ Stop: [{ matcher: 1, hooks: [] }] }) ?? "", /matcher that is not a string/);
    assert.match(err({ Stop: [{ hooks: "x" }] }) ?? "", /no hooks list/);
    assert.match(err({ Stop: [{ hooks: [1] }] }) ?? "", /no hooks list/);
    const r = parseSettings(JSON.stringify({ hooks: { Stop: {} } }));
    assert.equal(r.ok, false);
  });

  it("accepts a real-looking file", () => {
    assert.ok(parseSettings(JSON.stringify(theirs)).ok);
  });
});

describe("adding the hooks", () => {
  it("adds every entry point to an empty file, one group each", () => {
    const next = addEntries({}, missingEntries({}, WANTED, HOME));
    const expected = Object.fromEntries(Object.keys(ROUTES).map((e) => [e, [{ hooks: [hook(entryCommand(e))] }]]));
    assert.deepEqual(next, { hooks: expected });
  });

  it("keeps every other key and existing hook, in order, appending after them", () => {
    const next = addEntries(theirs, missingEntries(theirs, WANTED, HOME));
    assert.equal(next.model, "opus");
    assert.deepEqual(next.permissions, theirs.permissions);
    const hooks = next.hooks as Record<string, unknown[]>; // addEntries keeps hooks an object of lists
    assert.deepEqual(hooks.PreToolUse?.[0], theirs.hooks.PreToolUse[0]);
    // Their Stop hook stays first; the cockpit's is appended after it.
    assert.deepEqual(hooks.Stop?.[0], theirs.hooks.Stop[0]);
    assert.equal(hooks.Stop?.length, 2);
    assert.equal(hooks.PreToolUse?.length, 2);
    assert.deepEqual(Object.keys(next), ["model", "permissions", "hooks"]);
    // The input is not changed.
    assert.equal(theirs.hooks.PreToolUse.length, 1);
  });

  it("is idempotent: a second pass finds nothing missing", () => {
    const once = addEntries(theirs, missingEntries(theirs, WANTED, HOME));
    assert.deepEqual(missingEntries(once, WANTED, HOME), []);
    assert.deepEqual(addEntries(once, []), once);
  });

  it("counts an entry point already there under any spelling of home, but not under a narrower matcher", () => {
    const spelled = {
      hooks: {
        Stop: [{ hooks: [hook(`node ${HOME}/.config/cmux/scripts/hooks/dispatch.ts Stop`)] }],
        PermissionRequest: [
          { matcher: "", hooks: [hook("node ~/.config/cmux/scripts/hooks/dispatch.ts PermissionRequest")] },
        ],
        PreToolUse: [{ matcher: "Agent", hooks: [hook(entryCommand("PreToolUse"))] }],
      },
    };
    const missing = missingEntries(spelled, WANTED, HOME).map((e) => e.event);
    assert.ok(!missing.includes("Stop"));
    // A missing matcher and "" both mean every tool.
    assert.ok(!missing.includes("PermissionRequest"));
    // Under "Agent" it would run for one tool only, so it still counts as missing.
    assert.ok(missing.includes("PreToolUse"));
    assert.equal(missing.length, WANTED.length - 2);
  });

  it("spells each home form the same way", () => {
    for (const c of ["node $HOME/x.ts", "node $" + "{HOME}/x.ts", "node ~/x.ts", ` node ${HOME}/x.ts `]) {
      assert.equal(canonical(c, HOME), `node ${HOME}/x.ts`);
    }
    assert.equal(canonical("node $HOMEY/x.ts", HOME), "node $HOMEY/x.ts");
  });

  it("describes an entry with its matcher, or without one", () => {
    assert.ok(WANTED.map(describeEntry).includes("Stop: node $HOME/.config/cmux/scripts/hooks/dispatch.ts Stop"));
    const matched = { event: "PreToolUse", matcher: "Bash", command: "x", hook: hook("x") };
    assert.equal(describeEntry(matched), "PreToolUse [Bash]: x");
  });
});

describe("removing the hooks", () => {
  it("takes out only the cockpit's, leaving the rest as it was", () => {
    const added = addEntries(theirs, missingEntries(theirs, WANTED, HOME));
    const { settings, removed } = removeCommands(added, COMMANDS, HOME);
    assert.equal(removed, WANTED.length);
    assert.deepEqual(settings, theirs);
  });

  it("keeps a group's other hooks, and drops a group or event only when it empties", () => {
    const [subagent = "", , pr = ""] = LEGACY;
    const mixed = {
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [hook("mine.sh"), hook(pr)] }],
        SubagentStop: [{ hooks: [hook(subagent)] }],
        Notification: [],
      },
    };
    const { settings, removed } = removeCommands(mixed, LEGACY, HOME);
    assert.equal(removed, 2);
    assert.deepEqual(settings, {
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [hook("mine.sh")] }], Notification: [] },
    });
  });

  it("takes a command out under any matcher, and leaves a file with no hooks", () => {
    const old = hook("node ~/.config/cmux/scripts/hooks/report-subagent.ts");
    const other = { hooks: { PreToolUse: [{ matcher: "Other", hooks: [old] }] } };
    assert.equal(removeCommands(other, LEGACY, HOME).removed, 1);
    assert.deepEqual(removeCommands({ a: 1 }, COMMANDS, HOME), { settings: { a: 1 }, removed: 0 });
  });

  it("is idempotent", () => {
    const once = removeCommands(addEntries({}, WANTED), COMMANDS, HOME).settings;
    assert.deepEqual(removeCommands(once, COMMANDS, HOME), { settings: once, removed: 0 });
  });
});

describe("hooksState", () => {
  it("counts entry points missing and old per-script hooks left", () => {
    assert.deepEqual(hooksState(addEntries({}, WANTED), HOME), { missing: [], legacy: 0 });
    const state = hooksState({ hooks: { Stop: [{ hooks: LEGACY.map(hook) }] } }, HOME);
    assert.equal(state.missing.length, WANTED.length);
    assert.equal(state.legacy, LEGACY.length);
  });
});
