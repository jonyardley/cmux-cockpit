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
    const merged = mergeProjects(file, { "/dev/c": spec("C") });
    assert.deepEqual(
      merged.projects.map((x) => x.name),
      ["A", "B", "C"],
    );
    assert.deepEqual(merged.projects[2], { match: "/dev/c", ...spec("C") });
    assert.deepEqual(merged.kept, { "/dev/c": spec("C") });
    assert.ok(validateProjects(merged.projects).ok);
  });

  it("lets the file win on a shared match, any of a project's matches, or a shared name", () => {
    const merged = mergeProjects(file, { "/dev/a": spec("X"), "/dev/b2": spec("Y"), "/dev/z": spec("A") });
    assert.equal(merged.projects.length, 2);
    assert.deepEqual(merged.kept, {});
  });

  it("drops the second of two sidebar-made projects with the same name", () => {
    const merged = mergeProjects(file, { "/dev/c": spec("C"), "/dev/d": spec("C") });
    assert.deepEqual(Object.keys(merged.kept), ["/dev/c"]);
    assert.ok(validateProjects(merged.projects).ok);
  });
});
