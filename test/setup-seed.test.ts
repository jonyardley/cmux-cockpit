// Seeding config/projects.json from the open workspaces (scripts/setup/projects-seed.ts),
// setup's flags (scripts/setup/args.ts), versions, and the automations link decision.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProjects } from "../scripts/projects-config.ts";
import { choose, offered, parseFlags } from "../scripts/setup/args.ts";
import { planLink, ruleIds } from "../scripts/setup/automations.ts";
import { projectsJson, seedProjects, titleFrom, workspaceDirs } from "../scripts/setup/projects-seed.ts";
import { atLeast, parseVersion } from "../scripts/setup/versions.ts";
import { PROJECT_COLORS, PROJECT_ICONS } from "../src/shared/project-sets.ts";

const HOME = "/Users/someone";
const SKIP = [`${HOME}/.config/cmux`];

describe("seedProjects", () => {
  it("makes one project per repo, matched under home, rooted with ~", () => {
    const [p] = seedProjects([`${HOME}/Dev/My-App`], HOME, SKIP);
    assert.deepEqual(p, {
      match: "/dev/my-app/",
      name: "My App",
      color: PROJECT_COLORS[0],
      icon: PROJECT_ICONS[0],
      root: "~/Dev/My-App",
    });
  });

  it("dedupes, case included, and skips home and the cockpit's checkout", () => {
    const got = seedProjects(
      [
        `${HOME}/dev/a`,
        `${HOME}/dev/a/`,
        `${HOME}/DEV/A`,
        HOME,
        `${HOME}/.config/cmux`,
        `${HOME}/.config/cmux/sub`,
        `${HOME}/dev/b`,
      ],
      HOME,
      SKIP,
    );
    assert.deepEqual(
      got.map((p) => p.match),
      ["/dev/a/", "/dev/b/"],
    );
  });

  it("cycles colours and icons from the sidebar's own sets", () => {
    const tops = Array.from(
      { length: Math.max(PROJECT_COLORS.length, PROJECT_ICONS.length) + 1 },
      (_, i) => `${HOME}/dev/app-${i}`,
    );
    const got = seedProjects(tops, HOME, SKIP);
    assert.equal(got[1]?.color, PROJECT_COLORS[1]);
    assert.equal(got[PROJECT_COLORS.length]?.color, PROJECT_COLORS[0]);
    assert.equal(got[PROJECT_ICONS.length]?.icon, PROJECT_ICONS[0]);
    assert.ok(validateProjects(got).ok);
  });

  it("names a clash after its parent folder, then a number, so the validator passes", () => {
    const got = seedProjects([`${HOME}/dev/app`, `${HOME}/work/app`, `${HOME}/work/app_`], HOME, SKIP);
    assert.deepEqual(
      got.map((p) => p.name),
      ["App", "App (work)", "App 2"],
    );
    assert.ok(validateProjects(got).ok);
  });

  it("keeps a repo outside home as a full path", () => {
    const [p] = seedProjects(["/opt/Tools"], HOME, SKIP);
    assert.equal(p?.match, "/opt/tools/");
    assert.equal(p?.root, "/opt/Tools");
    assert.ok(validateProjects([p]).ok);
  });

  it("titles folders, and writes one project per line", () => {
    assert.equal(titleFrom("my-cool_app"), "My Cool App");
    assert.equal(titleFrom("---"), "");
    const [p] = seedProjects(["/x/---"], HOME, SKIP);
    assert.equal(p?.name, "Project");
    const text = projectsJson(seedProjects([`${HOME}/dev/a`, `${HOME}/dev/b`], HOME, SKIP));
    assert.equal(text.split("\n").length, 5);
    assert.ok(validateProjects(JSON.parse(text)).ok);
  });
});

describe("workspaceDirs", () => {
  it("reads each workspace's absolute current_directory and ignores the rest", () => {
    const parsed = {
      workspaces: [
        { current_directory: "/a" },
        { current_directory: null },
        { current_directory: "relative" },
        {},
        "x",
        { current_directory: "/b" },
      ],
    };
    assert.deepEqual(workspaceDirs(parsed), ["/a", "/b"]);
    assert.deepEqual(workspaceDirs(null), []);
    assert.deepEqual(workspaceDirs({ workspaces: {} }), []);
  });
});

describe("setup's flags", () => {
  const flags = (argv: string[]) => {
    const f = parseFlags(argv);
    if (typeof f === "string") throw new Error(f);
    return f;
  };

  it("asks on a terminal and skips elsewhere when no flag settles it", () => {
    assert.equal(choose("hooks", flags([]), true), "ask");
    assert.equal(choose("hooks", flags([]), false), "no");
  });

  it("says yes to all with --yes, no to all with --no-extras, and only the picked ones otherwise", () => {
    assert.equal(choose("helper", flags(["--yes"]), false), "yes");
    assert.equal(choose("helper", flags(["--no-extras", "--yes"]), true), "no");
    const picked = flags(["--hooks", "--hooks"]);
    assert.deepEqual(picked.picked, ["hooks"]);
    assert.equal(choose("hooks", picked, false), "yes");
    assert.equal(choose("helper", picked, true), "no");
  });

  it("narrows uninstall's steps the same way", () => {
    assert.ok(offered("helper", flags([])));
    assert.ok(!offered("helper", flags(["--hooks"])));
    assert.ok(offered("hooks", flags(["--hooks"])));
    assert.ok(!offered("hooks", flags(["--no-extras"])));
  });

  it("refuses an unknown flag", () => {
    assert.match(String(parseFlags(["--helpr"])), /unknown argument "--helpr"/);
  });
});

describe("versions", () => {
  it("reads node and cmux versions and compares them", () => {
    assert.deepEqual(parseVersion("cmux 0.64.25 (106) [b685a275c]"), [0, 64, 25]);
    assert.deepEqual(parseVersion("v24.2"), [24, 2, 0]);
    assert.equal(parseVersion("none"), null);
    assert.ok(atLeast([24, 10, 0], [24, 2, 0]));
    assert.ok(atLeast([24, 2, 0], [24, 2, 0]));
    assert.ok(!atLeast([0, 64, 9], [0, 64, 25]));
  });
});

describe("the automations link plan", () => {
  const repo = ["restore-agents-panel", "pr-poll-turn", "pr-poll-select"];

  it("links when nothing is there, and leaves our own link alone", () => {
    assert.deepEqual(planLink({ kind: "missing" }, repo), { do: "link" });
    assert.equal(planLink({ kind: "ours" }, repo).do, "nothing");
  });

  it("backs up a link that points elsewhere, and skips one whose file has rules of its own", () => {
    assert.deepEqual(planLink({ kind: "file", ruleIds: [], target: "/x.json" }, repo), {
      do: "backup-and-link",
      target: "/x.json",
    });
    assert.equal(planLink({ kind: "file", ruleIds: ["mine"], target: "/x.json" }, repo).do, "skip");
  });

  it("backs up a plain file holding only the repo's rules, such as one cmux copied over the link", () => {
    assert.equal(planLink({ kind: "file", ruleIds: ["pr-poll-turn"], target: null }, repo).do, "backup-and-link");
    assert.equal(planLink({ kind: "file", ruleIds: [], target: null }, repo).do, "backup-and-link");
  });

  it("skips a file with rules of its own, naming them, and one it cannot read", () => {
    const plan = planLink({ kind: "file", ruleIds: ["mine", "pr-poll-turn"], target: null }, repo);
    assert.equal(plan.do, "skip");
    assert.match(plan.do === "skip" ? plan.why : "", /rules the repo's does not: mine\. Copy them/);
    assert.equal(planLink({ kind: "file", ruleIds: null, target: null }, repo).do, "skip");
  });

  it("reads rule ids, naming unnamed rules by position", () => {
    assert.deepEqual(ruleIds(JSON.stringify({ rules: [{ id: "a" }, {}] })), ["a", "(unnamed rule 2)"]);
    assert.equal(ruleIds("nope"), null);
    assert.equal(ruleIds("{}"), null);
  });
});
