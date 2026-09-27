import assert from "node:assert/strict";
import { test } from "node:test";
import { applySet, emptyState, MAX_ENTRIES, validateState } from "../scripts/state-config.ts";

test("validateState reads a good file unchanged", () => {
  const raw = {
    dismissed: { w1: { a1: 100 } },
    projectOverride: { w2: "alpha" },
    projects: {
      "/users/jon/dev/scratch": {
        name: "Scratch",
        color: "#D97757",
        icon: "music.note",
        root: "/Users/jon/dev/scratch",
      },
    },
  };
  assert.deepEqual(validateState(raw), raw);
});

test("validateState turns anything that is not an object into empty state", () => {
  for (const raw of [null, undefined, 3, "x", [], [1]]) assert.deepEqual(validateState(raw), emptyState());
});

test("validateState drops bad ids, bad epochs, bad keys and empty entries", () => {
  const raw: Record<string, unknown> = {
    dismissed: { ["x".repeat(129)]: { a1: 1 }, w1: { a1: -1, a2: "5", constructor: 7, a4: 9 }, w2: {}, w3: [1] },
    projectOverride: { w4: 5, w5: "", w6: "ok" },
    extra: true,
  };
  assert.deepEqual(validateState(raw), { dismissed: { w1: { a4: 9 } }, projectOverride: { w6: "ok" }, projects: {} });
});

test("validateState keeps only the newest MAX_ENTRIES per map", () => {
  const many = Object.fromEntries(Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => [`w${i}`, "p"]));
  const kept = Object.keys(validateState({ projectOverride: many }).projectOverride);
  assert.equal(kept.length, MAX_ENTRIES);
  assert.equal(kept[0], "w5");
});

test("applySet sets, replaces and deletes an entry without changing its input", () => {
  const start = emptyState();
  const set = applySet(start, "projectOverride.w1", '"alpha"');
  assert.deepEqual(set, { ok: true, state: { dismissed: {}, projectOverride: { w1: "alpha" }, projects: {} } });
  assert.deepEqual(start, emptyState());
  if (!set.ok) return;

  const dismissed = applySet(set.state, "dismissed.w1", '{"a1":100}');
  assert.ok(dismissed.ok);
  if (!dismissed.ok) return;
  assert.deepEqual(dismissed.state.dismissed, { w1: { a1: 100 } });

  const cleared = applySet(dismissed.state, "projectOverride.w1", null);
  assert.ok(cleared.ok);
  if (cleared.ok) assert.deepEqual(cleared.state.projectOverride, {});
});

test("applySet refuses bad keys and bad values", () => {
  const s = emptyState();
  for (const [key, value] of [
    ["projectOverride", '"p"'],
    [".w1", '"p"'],
    ["projectOverride.", '"p"'],
    [`projectOverride.${"x".repeat(129)}`, '"p"'],
    ["projectOverride.w1", JSON.stringify("x".repeat(513))],
    ["other.w1", '"p"'],
    ["__proto__.w1", "{}"],
    ["projectOverride.__proto__", '"p"'],
    ["dismissed.w1", '{"constructor":1}'],
    ["projectOverride.w1", "not json"],
    ["projectOverride.w1", "5"],
    ["dismissed.w1", '{"a1":"x"}'],
    ["dismissed.w1", "{}"],
  ] as const) {
    assert.equal(applySet(s, key, value).ok, false, `${key} = ${value}`);
  }
});

test("applySet accepts real-shaped ids and path project keys", () => {
  const ws = "8F3C2A1E-0B6D-4E57-9A8B-1C2D3E4F5A6B";
  const override = applySet(emptyState(), `projectOverride.${ws}`, '"/dev/app-one"');
  assert.deepEqual(override.ok && override.state.projectOverride, { [ws]: "/dev/app-one" });
  const dismissed = applySet(emptyState(), `dismissed.${ws}`, '{"claude/session@1 x":100}');
  assert.deepEqual(dismissed.ok && dismissed.state.dismissed, { [ws]: { "claude/session@1 x": 100 } });
});

// Projects made in the sidebar (issue #9): keyed by their match, an absolute
// lowercase directory, and validated as strictly as any other entry.
const spec = { name: "Scratch", color: "#6A9BCC", icon: "folder.fill", root: "/Users/jon/dev/Scratch" };
const specJson = JSON.stringify(spec);

test("applySet sets and deletes a sidebar-made project under its match", () => {
  const set = applySet(emptyState(), "projects./users/jon/dev/scratch", specJson);
  assert.deepEqual(set.ok && set.state.projects, { "/users/jon/dev/scratch": spec });
  if (!set.ok) return;
  const del = applySet(set.state, "projects./users/jon/dev/scratch", null);
  assert.deepEqual(del.ok && del.state.projects, {});
});

test("applySet keeps a dotted match whole, since only the first dot splits the key", () => {
  const set = applySet(emptyState(), "projects./users/jon/.config/app.v2", specJson);
  assert.deepEqual(set.ok && Object.keys(set.state.projects), ["/users/jon/.config/app.v2"]);
});

test("applySet refuses a project with a bad match or spec", () => {
  const bad: [string, unknown][] = [
    ["projects.dev/scratch", spec],
    ["projects./Users/jon/dev/scratch", spec],
    [`projects./${"x".repeat(512)}`, spec],
    ["projects./dev/s", { ...spec, name: "" }],
    ["projects./dev/s", { ...spec, name: " padded" }],
    ["projects./dev/s", { ...spec, name: "a\u0007b" }],
    ["projects./dev/s", { ...spec, name: "x".repeat(65) }],
    ["projects./dev/s", { ...spec, color: "red" }],
    ["projects./dev/s", { ...spec, color: "#abc" }],
    ["projects./dev/s", { ...spec, icon: "Music Note" }],
    ["projects./dev/s", { ...spec, icon: "a..b" }],
    ["projects./dev/s", { ...spec, root: "~/dev/s" }],
    ["projects./dev/s", { ...spec, root: 5 }],
    ["projects./dev/s", "Scratch"],
  ];
  for (const [key, value] of bad) assert.equal(applySet(emptyState(), key, JSON.stringify(value)).ok, false, key);
});

test("applySet accepts a project with no root", () => {
  const { root: _, ...rootless } = spec;
  const set = applySet(emptyState(), "projects./dev/s", JSON.stringify(rootless));
  assert.deepEqual(set.ok && set.state.projects, { "/dev/s": rootless });
});

test("validateState drops bad projects and keeps good ones", () => {
  const raw = { projects: { "/dev/good": spec, "/dev/bad": { ...spec, color: 1 }, relative: spec, "/dev/X": spec } };
  assert.deepEqual(validateState(raw).projects, { "/dev/good": spec });
});
