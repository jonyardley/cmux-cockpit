import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { byActivity, mostActive, sinceOrActivity } = await import("../src/shared/activity.ts");
const { glyphColor } = await import("../src/shared/contrast.ts");
const { markLast } = await import("../src/shared/list.ts");
const { prChipColors } = await import("../src/shared/pr-colors.ts");
const { PROJECTS, PROJECT_COLORS, PROJECT_ICONS, matchesOf, newProject, nextIn, projectId, projectOf } = await import(
  "../src/shared/projects.ts"
);
const { cleanTitle, oneLine, readable, tracked } = await import("../src/shared/text.ts");
const { fmtAge, fmtElapsed, nowEpoch } = await import("../src/shared/time.ts");
const { agent } = await import("./support/fixtures.ts");

describe("cleanTitle", () => {
  it("drops a leading spinner glyph", () => {
    assert.equal(cleanTitle("✳ Fix the bridge"), "Fix the bridge");
    assert.equal(cleanTitle("⠋⠙ working"), "working");
  });
  it("keeps titles that start with a path, hash or bracket", () => {
    assert.equal(cleanTitle("~/dev/app-one"), "~/dev/app-one");
    assert.equal(cleanTitle("#42 review"), "#42 review");
    assert.equal(cleanTitle("[wip] thing"), "[wip] thing");
  });
  it("treats missing as empty", () => {
    assert.equal(cleanTitle(undefined), "");
    assert.equal(cleanTitle(null), "");
  });
});

describe("readable", () => {
  it("strips whole tag blocks, including nested ones", () => {
    assert.equal(readable("Done <task-notification><id>1</id></task-notification> now"), "Done now");
  });
  it("strips lone and unterminated tags", () => {
    assert.equal(readable("Hello <br/> world <unfinished"), "Hello world");
  });
  it("strips image and pasted-text placeholders", () => {
    assert.equal(readable("Look [Image #1] here [Pasted text #2 +40 lines]"), "Look here");
  });
  it("returns empty for path-only or markup-only messages", () => {
    assert.equal(readable("/private/tmp/claude/task-output.txt"), "");
    assert.equal(readable("<system-reminder>x</system-reminder>"), "");
    assert.equal(readable("~/a/b ../c"), "");
  });
  it("keeps a message that mentions a path among words", () => {
    assert.equal(readable("Wrote ~/notes.md for you"), "Wrote ~/notes.md for you");
  });
});

describe("oneLine", () => {
  it("cuts with an ellipsis at max characters", () => {
    assert.equal(oneLine("abcdefghij words", 8), "abcdefg…");
    assert.equal(oneLine("short words", 80), "short words");
  });
});

describe("projectOf", () => {
  it("matches the directory case-insensitively", () => {
    assert.equal(projectOf("/Users/coder/Dev/App-One/app").name, "App One");
  });
  it("matches any of a project's several paths", () => {
    assert.equal(projectOf("/Users/coder/Dev/App-Two/src").name, "App Two");
    assert.equal(projectOf("/Users/coder/.config/app-two").name, "App Two");
  });
  it("reads a single match or a list the same way, keyed by the first", () => {
    const one = { match: "/a", name: "A", color: "#000000", icon: "x" };
    const many = { match: ["/b", "/c"], name: "B", color: "#000000", icon: "x" };
    assert.deepEqual(matchesOf(one), ["/a"]);
    assert.deepEqual(matchesOf(many), ["/b", "/c"]);
    assert.equal(projectId(one), "/a");
    assert.equal(projectId(many), "/b");
  });
  it("falls back to a fresh no-project value that is never a PROJECTS member", () => {
    const p = projectOf("/tmp/elsewhere");
    assert.equal(p.name, "");
    assert.equal(p.icon, "terminal");
    assert.ok(!PROJECTS.includes(p));
    assert.notEqual(projectOf(undefined), projectOf(undefined));
  });
});

describe("glyphColor", () => {
  const DARK = "#141413"; // stands in for a sidebar's own `text` token

  it("picks a dark glyph on light project colours, issue #2's low-contrast case included", () => {
    assert.equal(glyphColor("#B0AEA5", DARK), DARK);
    assert.equal(glyphColor("#FFFFFF", DARK), DARK);
  });
  it("picks a white glyph on dark colours", () => {
    assert.equal(glyphColor(DARK, DARK), "#FFFFFF");
    assert.equal(glyphColor("#000000", DARK), "#FFFFFF");
  });
  it("reads a 3-digit hex the same as its expansion", () => {
    assert.equal(glyphColor("#fff", DARK), glyphColor("#ffffff", DARK));
    assert.equal(glyphColor("#000", DARK), glyphColor("#000000", DARK));
  });
  it("reads a 4 or 8-digit hex, ignoring the trailing alpha pair", () => {
    assert.equal(glyphColor("#fffa", DARK), glyphColor("#ffffff", DARK));
    assert.equal(glyphColor("#B0AEA580", DARK), glyphColor("#B0AEA5", DARK));
  });
  it("falls back to white for a background that is not a hex colour", () => {
    assert.equal(glyphColor("yellow", DARK), "#FFFFFF");
    assert.equal(glyphColor("clear", DARK), "#FFFFFF");
    assert.equal(glyphColor("", DARK), "#FFFFFF");
  });
  it("uses the caller's own dark token, not a fixed one", () => {
    assert.equal(glyphColor("#B0AEA5", "#000000"), "#000000");
  });
});

describe("activity ranking", () => {
  it("orders needs_input, working, idle, ended", () => {
    const list = [agent("ended"), agent("idle"), agent("needs_input"), agent("working")];
    assert.deepEqual(
      [...list].sort(byActivity).map((a) => a.status),
      ["needs_input", "working", "idle", "ended"],
    );
  });
  it("breaks ties by latest activity", () => {
    const old = agent("idle", { lastActivityAt: 10 });
    const recent = agent("idle", { lastActivityAt: 20 });
    assert.equal([old, recent].sort(byActivity)[0], recent);
    assert.equal(mostActive([old, recent]), recent);
  });
  it("mostActive agrees with sorting and keeps the first on a full tie", () => {
    const a = agent("working", { lastActivityAt: 5 });
    const b = agent("working", { lastActivityAt: 5 });
    assert.equal(mostActive([a, b]), a);
    assert.equal([a, b].sort(byActivity)[0], a);
  });
  it("mostActive skips holes and handles no agents", () => {
    const a = agent("idle");
    assert.equal(mostActive([null, a, undefined]), a);
    assert.equal(mostActive(undefined), null);
    assert.equal(mostActive([]), null);
  });
  it("sinceOrActivity prefers the status start, then last activity, then 0", () => {
    assert.equal(sinceOrActivity(agent("working", { sinceEpoch: 5, lastActivityAt: 9 })), 5);
    assert.equal(sinceOrActivity(agent("working", { lastActivityAt: 9 })), 9);
    assert.equal(sinceOrActivity(agent("working")), 0);
  });
});

describe("markLast", () => {
  it("flags only the final item", () => {
    assert.deepEqual(
      markLast([{ id: "a" }, { id: "b" }]).map((e) => e.last),
      [false, true],
    );
    assert.deepEqual(markLast([]), []);
  });
});

describe("time", () => {
  it("reads the app clock", () => {
    r.data.epoch = 1234;
    assert.equal(nowEpoch(), 1234);
  });
  it("fmtAge buckets coarsely", () => {
    assert.equal(fmtAge(0), "<1m");
    assert.equal(fmtAge(59), "<1m");
    assert.equal(fmtAge(60), "1m");
    assert.equal(fmtAge(3599), "59m");
    assert.equal(fmtAge(3600), "1h");
    assert.equal(fmtAge(86400 * 3), "3d");
    assert.equal(fmtAge(-1), "");
    assert.equal(fmtAge(Number.NaN), "");
  });
  it("fmtElapsed shows seconds and hours with minutes", () => {
    assert.equal(fmtElapsed(-5), "0s");
    assert.equal(fmtElapsed(45.9), "45s");
    assert.equal(fmtElapsed(720), "12m");
    assert.equal(fmtElapsed(3 * 3600 + 5 * 60), "3h 5m");
    assert.equal(fmtElapsed(2 * 86400), "2d");
  });
});

describe("tracked", () => {
  it("puts a hair space between letters, none at the ends", () => {
    assert.equal(tracked("ABC"), "A B C");
  });
  it("keeps a word gap as a plain space with no hair spaces round it", () => {
    assert.equal(tracked("AB CD"), "A B C D");
  });
  it("splits by character, not UTF-16 unit", () => {
    assert.equal(tracked("É😀"), "É 😀");
  });
  it("leaves empty and single-letter labels alone", () => {
    assert.equal(tracked(""), "");
    assert.equal(tracked("A"), "A");
  });
});

describe("newProject (issue #9)", () => {
  const taken = (name: string, color: string) => ({ match: "/x/" + name, name, color, icon: "x" });

  it("matches and roots at the folder, named after its last segment", () => {
    assert.deepEqual(newProject("/Users/jon/dev/scratch/", []), {
      key: "/users/jon/dev/scratch/",
      spec: { name: "Scratch", color: PROJECT_COLORS[0], icon: PROJECT_ICONS[0], root: "/Users/jon/dev/scratch" },
    });
  });

  it("cleans a folder name the state contract would refuse", () => {
    assert.equal(newProject("/dev/ my\u0007 notes ", [])?.spec.name, "My notes");
    const long = newProject("/dev/" + "x".repeat(80), [])?.spec.name ?? "";
    assert.equal(long.length, 60);
    assert.equal(newProject("/dev/   ", []), null);
  });

  it("numbers a name that is taken", () => {
    const made = newProject("/dev/scratch", [taken("Scratch", "#000000"), taken("Scratch 2", "#000000")]);
    assert.equal(made?.spec.name, "Scratch 3");
  });

  it("takes the first colour no project uses, case-insensitively", () => {
    const made = newProject("/dev/s", [taken("A", PROJECT_COLORS[0].toLowerCase()), taken("B", PROJECT_COLORS[1])]);
    assert.equal(made?.spec.color, PROJECT_COLORS[2]);
  });

  it("cycles by count once every colour is used", () => {
    const all = PROJECT_COLORS.map((c, i) => taken("P" + i, c));
    assert.equal(newProject("/dev/s", [...all, taken("Q", "#000000")])?.spec.color, PROJECT_COLORS[1]);
  });

  it("is null without an absolute folder two segments deep", () => {
    for (const d of [undefined, null, "", "/", "/dev", "/dev/", "~/dev/s", "dev/s"])
      assert.equal(newProject(d, []), null, String(d));
  });
});

describe("nextIn", () => {
  it("steps to the next item and wraps", () => {
    assert.equal(nextIn(PROJECT_ICONS, PROJECT_ICONS[0]), PROJECT_ICONS[1]);
    assert.equal(nextIn(PROJECT_ICONS, PROJECT_ICONS[PROJECT_ICONS.length - 1] ?? ""), PROJECT_ICONS[0]);
  });

  it("matches colours case-insensitively and starts over from an unknown value", () => {
    assert.equal(nextIn(PROJECT_COLORS, PROJECT_COLORS[0].toLowerCase()), PROJECT_COLORS[1]);
    assert.equal(nextIn(PROJECT_COLORS, "#000000"), PROJECT_COLORS[0]);
  });
});

describe("prChipColors", () => {
  it("shows the health when there is one, whatever the status", () => {
    assert.equal(prChipColors("failing", "open").fg, "#9E2F27");
    assert.equal(prChipColors("running", "open").fg, "#2F5690");
    assert.equal(prChipColors("ready", "open").fg, "#2F4A1C");
  });

  it("keeps the status colour while quiet, and is neutral with no status", () => {
    assert.equal(prChipColors("quiet", "open").fg, "#3F5A2C");
    assert.equal(prChipColors("quiet", "merged").fg, "#5B3E91");
    assert.deepEqual(prChipColors("quiet", undefined), prChipColors("quiet", "closed"));
    assert.deepEqual(prChipColors("quiet", undefined), { bg: "#F4F2EA", fg: "#4A4945", edge: "#E8E5DA" });
  });

  it("takes slate for a quiet open draft only, distinct from open and closed", () => {
    const draft = prChipColors("quiet", "open", true);
    assert.equal(draft.fg, "#4A5566");
    assert.notDeepEqual(draft, prChipColors("quiet", "open"));
    assert.notDeepEqual(draft, prChipColors("quiet", "closed"));
    assert.deepEqual(prChipColors("quiet", "merged", true), prChipColors("quiet", "merged"));
    assert.deepEqual(prChipColors("failing", "open", true), prChipColors("failing", "open"));
  });
});
