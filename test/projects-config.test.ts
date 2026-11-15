import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { mergeProjects, type Project, validateProjects } from "../scripts/projects-config.ts";

const p = (match: unknown, name = "A") => ({ match, name, color: "#000000", icon: "x" });
const error = (parsed: unknown): string => {
  const r = validateProjects(parsed);
  return r.ok ? "" : r.error;
};

describe("project table validation", () => {
  it("accepts the example table, single and list matches", () => {
    assert.ok(validateProjects(JSON.parse(readFileSync("config/projects.example.json", "utf8"))).ok);
    assert.ok(validateProjects([p("/a", "A"), p(["/b", "/c"], "B")]).ok);
  });

  it("rejects empty, uppercase or missing matches", () => {
    assert.match(error([p("")]), /lowercase/);
    assert.match(error([p("/Dev/app")]), /lowercase/);
    assert.match(error([p([])]), /lowercase/);
    assert.match(error([p(["/a", ""])]), /lowercase/);
    assert.match(error([p(["/a", "/B"])]), /lowercase/);
    assert.match(error([{ name: "A", color: "#000000", icon: "x" }]), /JSON array/);
    assert.match(error({}), /JSON array/);
  });

  it("rejects two projects with the same first match", () => {
    assert.match(error([p("/a", "A"), p(["/a", "/b"], "B")]), /first match "\/a"/);
  });

  it("rejects two projects with the same name, the #26 table", () => {
    assert.match(error([p("/.config/cmux", "Cockpit"), p("/dev/cmux-cockpit", "Cockpit")]), /named "Cockpit"/);
  });

  it("accepts an absolute, bare ~, or ~/ root; rejects anything else, including a bare ~name", () => {
    assert.ok(validateProjects([{ ...p("/a"), root: "/Users/jon/dev/app" }]).ok);
    assert.ok(validateProjects([{ ...p("/a"), root: "~/dev/app" }]).ok);
    assert.ok(validateProjects([{ ...p("/a"), root: "~" }]).ok);
    assert.match(error([{ ...p("/a"), root: "dev/app" }]), /absolute path/);
    assert.match(error([{ ...p("/a"), root: "" }]), /absolute path/);
    // build.ts's expandRoot only expands a bare "~" or a "~/..." prefix, so a
    // "~name/..." form (no slash right after ~) would reach the sidebar unexpanded.
    assert.match(error([{ ...p("/a"), root: "~jon/dev/app" }]), /absolute path/);
  });
});

describe("mergeProjects (issue #9)", () => {
  const file: Project[] = [
    { match: "/dev/a", name: "A", color: "#000000", icon: "x" },
    { match: ["/dev/b", "/dev/b2"], name: "B", color: "#000000", icon: "x" },
  ];
  const spec = (name: string) => ({ name, color: "#6A9BCC", icon: "folder.fill" });

  it("appends sidebar-made projects after the file's, keeping what it kept", () => {
    const merged = mergeProjects(file, { "/dev/c/": spec("C") });
    assert.deepEqual(
      merged.projects.map((x) => x.name),
      ["A", "B", "C"],
    );
    assert.deepEqual(merged.projects[2], { match: "/dev/c/", ...spec("C") });
    assert.deepEqual(merged.kept, { "/dev/c/": spec("C") });
    assert.ok(validateProjects(merged.projects).ok);
  });

  it("drops a sidebar-made project in a folder a file match claims, or with a file project's name", () => {
    const merged = mergeProjects(file, { "/dev/b2/sub/": spec("Y"), "/dev/z/": spec("A") });
    assert.equal(merged.projects.length, 2);
    assert.deepEqual(merged.kept, {});
  });

  it("marks the file's projects as seeded, and no others", () => {
    const merged = mergeProjects(file, { "/dev/c/": spec("C") });
    assert.deepEqual(
      merged.projects.map((x) => x.seeded ?? false),
      [true, true, false],
    );
  });

  it("lets a saved edit win over the file project it is keyed by, keeping its matches", () => {
    const edit = { ...spec("Bee"), root: "~/dev/b" };
    const merged = mergeProjects(file, { "/dev/b": edit });
    assert.deepEqual(merged.projects[1], { match: ["/dev/b", "/dev/b2"], ...edit, seeded: true });
    assert.deepEqual(merged.kept, { "/dev/b": edit });
    assert.ok(validateProjects(merged.projects).ok);
  });

  it("drops the file's root when the edit has none, so the header loses its +", () => {
    const withRoot: Project[] = [{ ...file[0], root: "~/dev/a" } as Project, ...file.slice(1)];
    const merged = mergeProjects(withRoot, { "/dev/a": spec("A") });
    assert.equal(merged.projects[0]?.root, undefined);
  });

  it("lets a sidebar-made project take a removed file project's folder and name", () => {
    const saved = { "/dev/a": { removed: true as const }, "/users/jon/dev/a/": spec("A") };
    const merged = mergeProjects(file, saved);
    assert.deepEqual(
      merged.projects.map((x) => x.match),
      [["/dev/b", "/dev/b2"], "/users/jon/dev/a/"],
    );
    assert.deepEqual(merged.kept, saved);
    assert.ok(validateProjects(merged.projects).ok);
  });

  it("leaves out a file project saved as removed, and keeps the removal", () => {
    const merged = mergeProjects(file, { "/dev/a": { removed: true } });
    assert.deepEqual(
      merged.projects.map((x) => x.name),
      ["B"],
    );
    assert.deepEqual(merged.kept, { "/dev/a": { removed: true } });
  });

  it("ignores a removal or a fragment key that no file project has", () => {
    const merged = mergeProjects(file, { "/dev/gone": spec("Gone"), "/dev/c/": { removed: true } });
    assert.equal(merged.projects.length, 2);
    assert.deepEqual(merged.kept, {});
  });

  it("drops an edit that would give two projects one name, keeping the file's entry", () => {
    const merged = mergeProjects(file, { "/dev/a": spec("B") });
    assert.deepEqual(
      merged.projects.map((x) => x.name),
      ["A", "B"],
    );
    assert.deepEqual(merged.kept, {});
  });

  it("lets two file projects swap names in one merge", () => {
    const merged = mergeProjects(file, { "/dev/a": spec("B"), "/dev/b": spec("A") });
    assert.deepEqual(
      merged.projects.map((x) => x.name),
      ["B", "A"],
    );
    assert.ok(validateProjects(merged.projects).ok);
  });

  it("puts a deeper folder first, so a folder inside another stays reachable", () => {
    const merged = mergeProjects(file, { "/dev/c/": spec("C"), "/dev/c/sub/": spec("Sub") });
    assert.deepEqual(
      merged.projects.map((x) => x.name),
      ["A", "B", "Sub", "C"],
    );
  });

  it("drops the second of two sidebar-made projects with the same name, deeper first", () => {
    const merged = mergeProjects(file, { "/dev/cc/": spec("C"), "/dev/d/": spec("C") });
    assert.deepEqual(Object.keys(merged.kept), ["/dev/cc/"]);
    assert.ok(validateProjects(merged.projects).ok);
  });
});
