// Adding and removing the cockpit's Claude Code hooks (scripts/setup/hooks-merge.ts),
// and the quickstart's by-hand block matching the one committed list.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HOOKS_SOURCE, wanted } from "../scripts/setup/claude-settings.ts";
import {
  addEntries,
  canonical,
  describe as describeEntry,
  hooksShapeError,
  missingEntries,
  parseSettings,
  removeEntries,
  wantedEntries,
} from "../scripts/setup/hooks-merge.ts";

const HOME = "/Users/someone";
const WANTED = wanted();
const cmd = (script: string): { type: string; command: string } => ({
  type: "command",
  command: `node $HOME/.config/cmux/scripts/hooks/${script}`,
});

const theirs = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
};

describe("the committed hook list", () => {
  it("is the quickstart's by-hand JSON block, so the doc cannot drift", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "quickstart.md"), "utf8");
    const section = doc.slice(doc.indexOf("### Claude Code hooks"));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    assert.ok(block, "the quickstart has a json block under Claude Code hooks");
    assert.deepEqual(JSON.parse(block), JSON.parse(readFileSync(HOOKS_SOURCE, "utf8")));
  });

  it("names every report-*.ts hook, each with a command", () => {
    const scripts = new Set(WANTED.map((e) => /report-[a-z]+\.ts/.exec(e.command)?.[0]));
    assert.deepEqual([...scripts].sort(), [
      "report-move.ts",
      "report-notification.ts",
      "report-pr.ts",
      "report-published.ts",
      "report-rename.ts",
      "report-subagent.ts",
    ]);
    assert.equal(WANTED.length, 11);
  });

  it("refuses a source that is not the settings shape", () => {
    assert.throws(() => wantedEntries([]), /not a settings object/);
    assert.throws(() => wantedEntries({ hooks: { X: {} } }), /not a settings object/);
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
  it("adds every entry to an empty file, in one group per event and matcher", () => {
    const next = addEntries({}, missingEntries({}, WANTED, HOME));
    assert.deepEqual(next, JSON.parse(readFileSync(HOOKS_SOURCE, "utf8")));
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
    assert.equal(hooks.PreToolUse?.length, 3);
    assert.deepEqual(Object.keys(next), ["model", "permissions", "hooks"]);
    // The input is not changed.
    assert.equal(theirs.hooks.PreToolUse.length, 1);
  });

  it("is idempotent: a second pass finds nothing missing", () => {
    const once = addEntries(theirs, missingEntries(theirs, WANTED, HOME));
    assert.deepEqual(missingEntries(once, WANTED, HOME), []);
    assert.deepEqual(addEntries(once, []), once);
  });

  it("counts a hook already there under any spelling of home, and only for its own matcher", () => {
    const spelled = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `node ${HOME}/.config/cmux/scripts/hooks/report-pr.ts` }],
          },
        ],
        PreToolUse: [{ matcher: "Other", hooks: [cmd("report-subagent.ts")] }],
        PermissionRequest: [
          { hooks: [{ type: "command", command: "node ~/.config/cmux/scripts/hooks/report-notification.ts" }] },
        ],
      },
    };
    const missing = missingEntries(spelled, WANTED, HOME).map(describeEntry);
    assert.ok(!missing.some((m) => m.startsWith("PostToolUse [Bash]")));
    assert.ok(missing.some((m) => m.startsWith("PreToolUse [Agent]")));
    // A missing matcher and "" both mean every tool.
    assert.ok(!missing.some((m) => m.startsWith("PermissionRequest")));
    assert.equal(missing.length, 9);
  });

  it("spells each home form the same way", () => {
    for (const c of ["node $HOME/x.ts", "node $" + "{HOME}/x.ts", "node ~/x.ts", ` node ${HOME}/x.ts `]) {
      assert.equal(canonical(c, HOME), `node ${HOME}/x.ts`);
    }
    assert.equal(canonical("node $HOMEY/x.ts", HOME), "node $HOMEY/x.ts");
  });

  it("describes an entry with its matcher, or without one", () => {
    const lines = WANTED.map(describeEntry);
    assert.ok(lines.includes("PostToolUse [Bash]: node $HOME/.config/cmux/scripts/hooks/report-pr.ts"));
    assert.ok(lines.includes("SubagentStart: node $HOME/.config/cmux/scripts/hooks/report-subagent.ts"));
  });
});

describe("removing the hooks", () => {
  it("takes out only the cockpit's, leaving the rest as it was", () => {
    const added = addEntries(theirs, missingEntries(theirs, WANTED, HOME));
    const { settings, removed } = removeEntries(added, WANTED, HOME);
    assert.equal(removed, 11);
    assert.deepEqual(settings, theirs);
  });

  it("keeps a group's other hooks, and drops a group or event only when it empties", () => {
    const mixed = {
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }, cmd("report-pr.ts")] }],
        SubagentStop: [{ hooks: [cmd("report-subagent.ts")] }],
        Notification: [],
      },
    };
    const { settings, removed } = removeEntries(mixed, WANTED, HOME);
    assert.equal(removed, 2);
    assert.deepEqual(settings, {
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }], Notification: [] },
    });
  });

  it("leaves a cockpit command under another matcher, and a file with no hooks", () => {
    const other = { hooks: { PreToolUse: [{ matcher: "Other", hooks: [cmd("report-subagent.ts")] }] } };
    assert.equal(removeEntries(other, WANTED, HOME).removed, 0);
    assert.deepEqual(removeEntries({ a: 1 }, WANTED, HOME), { settings: { a: 1 }, removed: 0 });
  });

  it("is idempotent", () => {
    const once = removeEntries(addEntries({}, WANTED), WANTED, HOME).settings;
    assert.deepEqual(removeEntries(once, WANTED, HOME), { settings: once, removed: 0 });
  });
});
