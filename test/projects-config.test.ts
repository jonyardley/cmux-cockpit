import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateProjects } from "../scripts/projects-config.ts";

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

  it("accepts an absolute or ~ root, rejects a relative or empty one", () => {
    assert.ok(validateProjects([{ ...p("/a"), root: "/Users/jon/dev/app" }]).ok);
    assert.ok(validateProjects([{ ...p("/a"), root: "~/dev/app" }]).ok);
    assert.match(error([{ ...p("/a"), root: "dev/app" }]), /absolute path/);
    assert.match(error([{ ...p("/a"), root: "" }]), /absolute path/);
  });
});
