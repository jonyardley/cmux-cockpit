import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_MAX_AGE_S,
  applySet,
  cleanLabel,
  emptyState,
  labelFrom,
  MAX_ENTRIES,
  MAX_LABEL,
  MAX_SUBAGENTS,
  rebuildsOn,
  urlMaySet,
  validateState,
} from "../scripts/state-config.ts";

test("validateState reads a good file unchanged", () => {
  const raw = {
    dismissed: { w1: { a1: 100 } },
    projectOverride: { w2: "alpha" },
    projects: {
      "/users/jon/dev/scratch/": {
        name: "Scratch",
        color: "#D97757",
        icon: "music.note",
        root: "/Users/jon/dev/scratch",
      },
    },
    prs: { w3: { number: 7, url: "https://github.com/o/r/pull/7", status: "open", branch: "feat" } },
    ownPrs: {
      "https://github.com/o/r/pull/8": {
        number: 8,
        url: "https://github.com/o/r/pull/8",
        status: "open",
        branch: "mine",
        title: "Mine",
        repo: "/r/.git",
      },
    },
    subagents: {
      w4: [
        { id: "toolu_1", session: "s1", agentId: "a1", label: "Review the diff", startedEpoch: 100, endedEpoch: 160 },
        { id: "toolu_2", session: "s1", label: "Probe the hook", startedEpoch: 150 },
      ],
    },
    names: { s1: { name: "Real names on agent rows", from: "prompt" } },
    published: {
      "https://claude.ai/code/artifact/0b3c-9e2a": {
        url: "https://claude.ai/code/artifact/0b3c-9e2a",
        title: "Lane board",
        kind: "page",
        workspace: "w5",
        epoch: 200,
      },
    },
    prOrigins: {
      "https://github.com/o/r/pull/5": {
        url: "https://github.com/o/r/pull/5",
        number: 5,
        workspace: "w5",
        surface: "s5",
        session: "sess",
        epoch: 200,
      },
    },
    asking: { w6: { reason: "allow git push?", epoch: 300, session: "s1" }, w7: { reason: "a question", epoch: 301 } },
    moves: {
      w8: { text: "Run /clear now.", epoch: 302, session: "s1", decisions: 2, leans: "1b 2a" },
      w9: { text: "go", epoch: 303 },
      w10: { text: "CI is running.", epoch: 304, idle: true },
    },
    ui: { mode: "projects", collapsed: { "lane:parked": 0, "project:/dev/a": 1 } },
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
  assert.deepEqual(validateState(raw), {
    dismissed: { w1: { a4: 9 } },
    projectOverride: { w6: "ok" },
    projects: {},
    prs: {},
    ownPrs: {},
    subagents: {},
    names: {},
    published: {},
    prOrigins: {},
    asking: {},
    moves: {},
    ui: {},
  });
});

test("validateState keeps good subagent runs, drops bad ones and keeps the newest MAX_SUBAGENTS", () => {
  const run = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `t${i}`,
    session: "s1",
    label: "Run",
    startedEpoch: i,
    ...extra,
  });
  const bad = [
    run(1, { label: " padded" }),
    run(2, { label: "x".repeat(MAX_LABEL + 1) }),
    run(3, { session: "" }),
    run(4, { agentId: 5 }),
    run(5, { endedEpoch: -1 }),
    run(6, { id: "__proto__" }),
    run(7, { label: "tab\there" }),
  ];
  const good = Array.from({ length: MAX_SUBAGENTS + 2 }, (_, i) => run(10 + i));
  const { subagents } = validateState({ subagents: { w1: [...bad, ...good], w2: bad, w3: "x" } });
  assert.deepEqual(Object.keys(subagents), ["w1"]);
  assert.deepEqual(
    subagents.w1?.map((r) => r.id),
    good.slice(2).map((r) => r.id),
  );
});

test("validateState keeps good published links and drops bad ones", () => {
  const good = { url: "https://claude.ai/artifact/abc", title: "Plan", kind: "doc", workspace: "w1", epoch: 5 };
  const bad = [
    { ...good, url: "https://evil.example/artifact/abc" },
    { ...good, url: "https://claude.ai/artifact/abc?x=1" },
    { ...good, title: " padded " },
    { ...good, title: "" },
    { ...good, kind: "deck" },
    { ...good, workspace: "" },
    { ...good, workspace: 7 },
    { ...good, epoch: -1 },
    "not an entry",
  ];
  const raw = Object.fromEntries([[good.url, good], ...bad.map((b, i) => [`https://claude.ai/artifact/b${i}`, b])]);
  assert.deepEqual(validateState({ published: raw }).published, { [good.url]: good });
  const badKey = validateState({ published: { "https://example.com/x": good } }).published;
  assert.deepEqual(badKey, {});
});

test("applySet refuses to set published links from a URL", () => {
  const value = JSON.stringify({
    url: "https://claude.ai/artifact/a",
    title: "T",
    kind: "page",
    workspace: "w",
    epoch: 1,
  });
  assert.deepEqual(applySet(emptyState(), "published.https://claude.ai/artifact/a", value), {
    ok: false,
    error: "unknown map published",
  });
});

test("applySet refuses to set subagents from a URL", () => {
  assert.deepEqual(applySet(emptyState(), "subagents.w1", "[]"), { ok: false, error: "unknown map subagents" });
});

test("validateState keeps a good subagent type, bounded like an id, and drops a bad one", () => {
  const run = (extra: Record<string, unknown> = {}) => ({
    id: "t1",
    session: "s1",
    label: "Run",
    startedEpoch: 1,
    ...extra,
  });
  const { subagents } = validateState({
    subagents: {
      w1: [run({ type: "code-reviewer" })],
      w2: [run({ type: "" })],
      w3: [run({ type: "x".repeat(129) })],
      w4: [run({ type: 5 })],
      w5: [run()],
    },
  });
  assert.equal(subagents.w1?.[0]?.type, "code-reviewer");
  assert.equal(subagents.w2?.[0]?.type, undefined);
  assert.equal(subagents.w3, undefined);
  assert.equal(subagents.w4, undefined);
  assert.equal(subagents.w5?.[0]?.type, undefined);
});

test("isName and isLabel reject code 127 (DEL), the same control character the hook's dropControl turns to a space", () => {
  const run = { id: "t1", session: "s1", startedEpoch: 1, label: `a\u007fb` };
  assert.deepEqual(validateState({ subagents: { w1: [run] } }).subagents, {});
  assert.deepEqual(
    validateState({ projects: { "/dev/s/": { name: "a\u007fb", color: "#6A9BCC", icon: "folder.fill" } } }).projects,
    {},
  );
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
  assert.deepEqual(set, {
    ok: true,
    state: {
      dismissed: {},
      projectOverride: { w1: "alpha" },
      projects: {},
      prs: {},
      ownPrs: {},
      subagents: {},
      names: {},
      published: {},
      prOrigins: {},
      asking: {},
      moves: {},
      ui: {},
    },
  });
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

// Projects made or edited in the sidebar (issue #9): keyed by their first
// match, and validated as strictly as any other entry.
const spec = { name: "Scratch", color: "#6A9BCC", icon: "folder.fill", root: "/Users/jon/dev/Scratch" };
const specJson = JSON.stringify(spec);

test("applySet sets and deletes a sidebar-made project under its match", () => {
  const set = applySet(emptyState(), "projects./users/jon/dev/scratch/", specJson);
  assert.deepEqual(set.ok && set.state.projects, { "/users/jon/dev/scratch/": spec });
  if (!set.ok) return;
  const del = applySet(set.state, "projects./users/jon/dev/scratch/", null);
  assert.deepEqual(del.ok && del.state.projects, {});
});

test("applySet keeps a dotted match whole, since only the first dot splits the key", () => {
  const set = applySet(emptyState(), "projects./users/jon/.config/app.v2/", specJson);
  assert.deepEqual(set.ok && Object.keys(set.state.projects), ["/users/jon/.config/app.v2/"]);
});

test("applySet refuses a project with a bad match or spec", () => {
  const bad: [string, unknown][] = [
    ["projects.dev/scratch/", spec],
    // "/" or one segment would match nearly every folder.
    ["projects./", spec],
    ["projects./dev/", spec],
    ["projects./dev", spec],
    ["projects./Users/jon/dev/scratch/", spec],
    [`projects./a/${"x".repeat(512)}/`, spec],
    ["projects./dev/s/", { ...spec, name: "" }],
    ["projects./dev/s/", { ...spec, name: " padded" }],
    ["projects./dev/s/", { ...spec, name: "a\u0007b" }],
    ["projects./dev/s/", { ...spec, name: "x".repeat(65) }],
    ["projects./dev/s/", { ...spec, color: "red" }],
    ["projects./dev/s/", { ...spec, color: "#abc" }],
    ["projects./dev/s/", { ...spec, icon: "Music Note" }],
    ["projects./dev/s/", { ...spec, icon: "a..b" }],
    ["projects./dev/s/", { ...spec, root: "~jon/dev/s" }],
    ["projects./dev/s/", { removed: false }],
    ["projects./dev/s/", { removed: true, name: "Scratch" }],
    ["projects./dev/s/", { ...spec, root: "dev/s" }],
    ["projects./dev/s/", { ...spec, root: 5 }],
    ["projects./dev/s/", "Scratch"],
  ];
  for (const [key, value] of bad) assert.equal(applySet(emptyState(), key, JSON.stringify(value)).ok, false, key);
});

test("applySet takes a projects.json project's edit or removal under its fragment, and a ~ root", () => {
  const edit = { ...spec, root: "~/dev/s" };
  const set = applySet(emptyState(), "projects./dev/s", JSON.stringify(edit));
  assert.deepEqual(set.ok && set.state.projects, { "/dev/s": edit });
  const gone = applySet(emptyState(), "projects./.config/cmux", JSON.stringify({ removed: true }));
  assert.deepEqual(gone.ok && gone.state.projects, { "/.config/cmux": { removed: true } });
});

test("applySet accepts a project with no root", () => {
  const { root: _, ...rootless } = spec;
  const set = applySet(emptyState(), "projects./dev/s/", JSON.stringify(rootless));
  assert.deepEqual(set.ok && set.state.projects, { "/dev/s/": rootless });
});

test("validateState drops bad projects and keeps good ones", () => {
  const raw = {
    projects: {
      "/dev/good/": spec,
      "/dev/bad/": { ...spec, color: 1 },
      relative: spec,
      "/dev/X/": spec,
      "/dev": spec,
      "/dev/fragment": spec,
      "/dev/gone": { removed: true },
    },
  };
  assert.deepEqual(validateState(raw).projects, {
    "/dev/good/": spec,
    "/dev/fragment": spec,
    "/dev/gone": { removed: true },
  });
});

test("applySet sets and deletes the cockpit's view and folds under ui", () => {
  const mode = applySet(emptyState(), "ui.mode", '"projects"');
  assert.ok(mode.ok);
  if (!mode.ok) return;
  assert.deepEqual(mode.state.ui, { mode: "projects" });

  const folds = applySet(mode.state, "ui.collapsed", '{"lane:unsorted":1,"lane:parked":0,"project:/dev/a":1}');
  assert.ok(folds.ok);
  if (!folds.ok) return;
  assert.deepEqual(folds.state.ui, {
    mode: "projects",
    collapsed: { "lane:unsorted": 1, "lane:parked": 0, "project:/dev/a": 1 },
  });

  const cleared = applySet(folds.state, "ui.mode", null);
  assert.ok(cleared.ok);
  if (cleared.ok) assert.deepEqual(cleared.state.ui, { collapsed: folds.state.ui.collapsed });
});

test("applySet refuses a bad ui key or value", () => {
  for (const [key, value] of [
    ["ui.other", '"all"'],
    ["ui.__proto__", '"all"'],
    ["ui.mode", '"lanes"'],
    ["ui.mode", "1"],
    ["ui.collapsed", "{}"],
    ["ui.collapsed", '{"lane:main":2}'],
    ["ui.collapsed", '["lane:main"]'],
  ] as const) {
    assert.equal(applySet(emptyState(), key, value).ok, false, `${key} = ${value}`);
  }
});

test("validateState keeps a good ui and drops bad modes and flags", () => {
  assert.deepEqual(validateState({ ui: { mode: "all", collapsed: { "lane:main": 1 } } }).ui, {
    mode: "all",
    collapsed: { "lane:main": 1 },
  });
  assert.deepEqual(
    validateState({ ui: { mode: "grid", collapsed: { a: "1", constructor: 1, [`project:${"y".repeat(600)}`]: 1 } } })
      .ui,
    {},
  );
  assert.deepEqual(validateState({ ui: "projects" }).ui, {});
});

test("a fold on a project with a long match path is kept, not dropped", () => {
  const key = `project:/users/jon/${"deep/".repeat(40)}`;
  const set = applySet(emptyState(), "ui.collapsed", JSON.stringify({ [key]: 1 }));
  assert.ok(set.ok);
  if (set.ok) assert.deepEqual(set.state.ui.collapsed, { [key]: 1 });
});

test("rebuildsOn skips the build for the cockpit's own view, folds and lane names only", () => {
  assert.equal(rebuildsOn("ui.mode"), false);
  assert.equal(rebuildsOn("ui.collapsed"), false);
  assert.equal(rebuildsOn("laneNames.main"), false);
  for (const key of ["dismissed.w1", "projectOverride.w1", "projects./dev/a/"])
    assert.equal(rebuildsOn(key), true, key);
});

test("a file from when lanes moved themselves drops its seen PR states", () => {
  assert.equal(Object.hasOwn(validateState({ prSeen: { w1: "merged" } }), "prSeen"), false);
  assert.equal(applySet(emptyState(), "prSeen.w1", JSON.stringify("ready")).ok, false);
});

test("a file from when merged cards had Keep still loads, without its kept PRs", () => {
  const old = validateState({ mergeKept: { w1: 5 }, projectOverride: { w2: "alpha" } });
  assert.equal(Object.hasOwn(old, "mergeKept"), false);
  assert.deepEqual(old.projectOverride, { w2: "alpha" }, "the rest of the file reads as before");
  assert.equal(applySet(emptyState(), "mergeKept.w1", JSON.stringify(5)).ok, false);
});

test("cleanLabel cuts by the length isLabel measures, so an astral title still validates", () => {
  // 119 units then a two-unit emoji: the emoji would make 121, so it goes whole.
  const title = cleanLabel("\u{1F3B9}" + "x".repeat(117) + "\u{1F3B9}x") ?? "";
  assert.equal(title.length, MAX_LABEL - 1);
  assert.ok(title.startsWith("\u{1F3B9}x") && title.endsWith("x"));
  const entry = { url: "https://claude.ai/artifact/a", title, kind: "page", workspace: "w", epoch: 1 };
  assert.deepEqual(validateState({ published: { [entry.url]: entry } }).published, { [entry.url]: entry });
  assert.equal(cleanLabel("a\u0000\u007f\tb"), "a b");
  assert.equal(cleanLabel(" \n "), null);
  assert.equal(cleanLabel(5), null);
});

test("labelFrom takes the first usable candidate, else the fallback", () => {
  assert.equal(labelFrom("none", undefined, "  ", "Second"), "Second");
  assert.equal(labelFrom("none"), "none");
});

test("validateState keeps a good poll status and drops bad fields one by one (#78)", () => {
  const good = { okEpoch: 100, error: "unavailable" };
  assert.deepEqual(validateState({ poll: good }).poll, good);
  assert.deepEqual(validateState({ poll: { okEpoch: 100 } }).poll, { okEpoch: 100 });
  // A bad error goes and a good success stays, and the other way round.
  assert.deepEqual(validateState({ poll: { okEpoch: 100, error: "down" } }).poll, { okEpoch: 100 });
  assert.deepEqual(validateState({ poll: { okEpoch: -1, error: "signed-out", extra: 1 } }).poll, {
    error: "signed-out",
  });
  assert.deepEqual(validateState({ poll: { error: "missing" } }).poll, { error: "missing" });
});

test("validateState leaves poll out when nothing usable is saved", () => {
  for (const poll of [undefined, null, [], "x", {}, { okEpoch: "1" }, { error: "down" }]) {
    assert.equal("poll" in validateState({ poll }), false, JSON.stringify(poll));
  }
  assert.equal("poll" in emptyState(), false);
});

test("applySet refuses poll, so no URL can say gh is down", () => {
  assert.equal(applySet(emptyState(), "poll.error", '"unavailable"').ok, false);
});

// --- asking (issue #81) ---

test("urlMaySet refuses the hook-only asking map and allows the rest", () => {
  assert.equal(urlMaySet("asking.w1"), false);
  assert.equal(urlMaySet("asking"), false);
  for (const key of ["dismissed.w1", "projectOverride.w1", "projects./a/b/", "ui.mode", "nodot"])
    assert.equal(urlMaySet(key), true, key);
});

test("applySet saves an ask, replaces it and deletes it", () => {
  const ask = { reason: "allow git push?", epoch: 1000, session: "s1" };
  const set = applySet(emptyState(), "asking.w1", JSON.stringify(ask));
  assert.equal(set.ok, true);
  if (!set.ok) return;
  assert.deepEqual(set.state.asking, { w1: ask });
  assert.equal(rebuildsOn("asking.w1"), true);
  const next = applySet(set.state, "asking.w1", JSON.stringify({ reason: "Which layout?", epoch: 1100 }));
  assert.deepEqual(next.ok && next.state.asking, { w1: { reason: "Which layout?", epoch: 1100 } });
  const gone = applySet(set.state, "asking.w1", null);
  assert.deepEqual(gone.ok && gone.state.asking, {});
});

test("applySet refuses an ask with no reason, a bad epoch, a bad session or a bad key", () => {
  for (const value of [
    { epoch: 1 },
    { reason: "", epoch: 1 },
    { reason: " padded ", epoch: 1 },
    { reason: "r", epoch: -1 },
    { reason: "r", epoch: 1, session: 5 },
    { reason: "r", epoch: 1, session: "__proto__" },
    "r",
  ]) {
    const set = applySet(emptyState(), "asking.w1", JSON.stringify(value));
    assert.deepEqual(set, { ok: false, error: "asking wants {reason, epoch, session?}" }, JSON.stringify(value));
  }
  assert.equal(applySet(emptyState(), "asking.__proto__", '{"reason":"r","epoch":1}').ok, false);
});

test("applySet drops asks a day older than the new one, keeping the rest", () => {
  const old = { reason: "old", epoch: 1000 };
  const edge = { reason: "edge", epoch: 1000 + 1 };
  const start = { ...emptyState(), asking: { gone: old, kept: edge } };
  const set = applySet(start, "asking.w1", JSON.stringify({ reason: "new", epoch: 1001 + ASK_MAX_AGE_S }));
  assert.deepEqual(set.ok && Object.keys(set.state.asking), ["kept", "w1"]);
});

test("validateState keeps good asks and drops bad ones", () => {
  const state = validateState({
    asking: {
      w1: { reason: "allow git push?", epoch: 5, session: "s1", extra: true },
      w2: { reason: "no epoch" },
      w3: { reason: "bad session", epoch: 5, session: "" },
      w4: "nope",
    },
  });
  assert.deepEqual(state.asking, { w1: { reason: "allow git push?", epoch: 5, session: "s1" } });
});

test("validateState keeps good session names and drops bad ones", () => {
  const good = { name: "Real names on agent rows", from: "prompt" };
  const { names } = validateState({
    names: {
      s1: good,
      s2: { name: "Design Review", from: "title" },
      s3: { name: " padded", from: "prompt" },
      s4: { name: "x".repeat(MAX_LABEL + 1), from: "prompt" },
      s5: { name: "Fine", from: "url" },
      s6: "Fine",
      __proto__: good,
    },
  });
  assert.deepEqual(names, { s1: good, s2: { name: "Design Review", from: "title" } });
  assert.deepEqual(validateState({}).names, {});
});

test("applySet refuses to set a session name from a URL", () => {
  assert.deepEqual(applySet(emptyState(), "names.s1", '{"name":"x","from":"title"}'), {
    ok: false,
    error: "unknown map names",
  });
});

test("laneNames keeps each lane id's last name, and is left out while empty", () => {
  const set = applySet(emptyState(), "laneNames.main", JSON.stringify("Doing"));
  assert.ok(set.ok);
  assert.deepEqual(set.state.laneNames, { main: "Doing" });
  const cleared = applySet(set.state, "laneNames.main", null);
  assert.ok(cleared.ok);
  assert.equal(Object.hasOwn(cleared.state, "laneNames"), false);
  assert.equal(Object.hasOwn(validateState({}), "laneNames"), false);
  assert.deepEqual(validateState({ laneNames: { main: "Doing", bad: 7, pad: " x" } }).laneNames, { main: "Doing" });
  assert.equal(applySet(emptyState(), "laneNames.main", JSON.stringify(7)).ok, false);
  assert.equal(urlMaySet("laneNames.main"), true);
});
