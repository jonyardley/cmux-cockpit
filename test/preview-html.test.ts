// test/support/html.ts: the preview's tree-to-HTML mapping. Every snapshot
// scene also has to render with nothing unknown (test/support/snapshot.ts).

import assert from "node:assert/strict";
import { it } from "node:test";
import { toPage } from "./support/html.ts";
import type { ViewNode } from "./support/renderer.ts";

const node = (kind: string, args: unknown[], mods: [string, unknown?][] = [], children: ViewNode[] = []): ViewNode => ({
  kind,
  args,
  mods: mods.map(([name, v]) => ({ name, values: v === undefined ? [] : [v] })),
  children,
  handlers: {},
});

const body = (root: ViewNode): string => {
  const html = toPage(root, "t", 300, "#FFFFFF").html;
  return /<div id="root">(.*)<\/div><script>/.exec(html)?.[1] ?? "";
};

it("lays a stack out as flex with its spacing and alignment", () => {
  const out = body(node("HStack", [{ spacing: 6, alignment: "top" }], [], [node("Text", ["a"])]));
  assert.equal(out, '<div class="row" style="gap:6px;align-items:flex-start"><div class="t">a</div></div>');
});

it("wraps each layout modifier round what came before, in call order", () => {
  const out = body(
    node(
      "Text",
      ["a"],
      [
        ["color", "#112233"],
        ["padding", 4],
        ["background", "#FFEEDD"],
      ],
    ),
  );
  assert.equal(
    out,
    '<div class="w" style="background:#FFEEDD"><div class="w" style="padding:4px"><div class="t" style="color:#112233">a</div></div></div>',
  );
});

it("marks a maxWidth: infinity frame, and the stack holding it, as filling", () => {
  const inner = node("Text", ["a"], [["frame", { maxWidth: "infinity", alignment: "leading" }]]);
  const out = body(node("VStack", [{}], [], [inner]));
  assert.match(out, /^<div class="col fw"/);
  assert.match(out, /<div class="w fw" style="align-items:flex-start">/);
});

it("lets a fixed width stop a fill", () => {
  const out = body(node("Rectangle", [], [["frame", { width: 10, height: 1 }]]));
  assert.doesNotMatch(out, /^<div class="w fw/);
});

it("fills a sized circle itself rather than wrapping it", () => {
  const out = body(node("Circle", [{ size: 7 }], [["fill", "#3366CC"]]));
  assert.equal(out, '<div class="shape dot" style="width:7px;height:7px;background:#3366CC"></div>');
});

it("draws a valued ProgressView as a bar", () => {
  assert.match(body(node("ProgressView", [], [["value", 0.25]])), /class="bar[^"]*"><div style="width:25%">/);
});

it("hides showOnHover content and ignores tap handlers", () => {
  const page = toPage(node("Text", ["a"], [["showOnHover"], ["onTap"]]), "t", 300, "#FFFFFF");
  assert.deepEqual(page.unknown, []);
  assert.match(page.html, /<div class="t" style="opacity:0">a<\/div>/);
});

it("hides showOnHover content only while its flag is on", () => {
  assert.equal(body(node("Text", ["a"], [["showOnHover", true]])), '<div class="t" style="opacity:0">a</div>');
  assert.equal(body(node("Text", ["a"], [["showOnHover", false]])), '<div class="t">a</div>');
  assert.equal(body(node("Text", ["a"], [["showOnHover", () => false]])), '<div class="t">a</div>');
  assert.equal(body(node("Text", ["a"], [["showOnHover", () => true]])), '<div class="t" style="opacity:0">a</div>');
});

it("overlaps a stack's children by a negative spacing, which a CSS gap cannot", () => {
  const out = body(node("HStack", [{ spacing: -3 }], [], [node("Text", ["a"]), node("Text", ["b"])]));
  assert.equal(
    out,
    '<div class="row" style="gap:0px"><div class="t">a</div><div class="t" style="margin-left:-3px">b</div></div>',
  );
  const col = body(node("VStack", [{ spacing: -2 }], [], [node("Text", ["a"]), node("Text", ["b"])]));
  assert.match(col, /<div class="t" style="margin-top:-2px">b<\/div>/);
});

it("paints a shape's fill on the shape, keeping its radius, after a wrapping modifier", () => {
  const out = body(
    node(
      "Circle",
      [{}],
      [
        ["frame", { width: 10, height: 10 }],
        ["fill", "#3366CC"],
      ],
    ),
  );
  assert.match(out, /<div class="shape[^"]*" style="border-radius:50%;background:#3366CC">/);
  assert.doesNotMatch(out, /class="w" style="[^"]*background/);
  const rounded = body(
    node(
      "RoundedRectangle",
      [{ cornerRadius: 4 }],
      [
        ["padding", 2],
        ["fill", "#3366CC"],
      ],
    ),
  );
  assert.match(rounded, /<div class="shape[^"]*" style="border-radius:4px;background:#3366CC">/);
});

it("lists and outlines what it cannot draw", () => {
  const page = toPage(node("Blob", [], [["sparkle", 1]]), "t", 300, "#FFFFFF");
  assert.deepEqual(page.unknown, [".sparkle", "Blob"]);
  assert.match(page.html, /outline:1px dashed/);
});

it("escapes text", () => {
  assert.equal(body(node("Text", ['<a & "b">'])), '<div class="t">&lt;a &amp; &quot;b&quot;&gt;</div>');
});

it("shows a TextField's placeholder faint when it is empty, and its value otherwise", () => {
  assert.match(body(node("TextField", ["", { placeholder: "Name" }])), /color:#14141466">Name<\/span>/);
  assert.match(body(node("TextField", ["~/dev", { placeholder: "Name" }])), />~\/dev<\/div>$/);
});

it("gives an empty list with modifiers no slot in its stack's gap", () => {
  const empty = node("ForEach", [], [["layoutPriority", 2]]);
  const out = body(node("HStack", [{ spacing: 5 }], [], [empty, node("Text", ["a"])]));
  assert.equal(
    out,
    '<div class="row" style="gap:5px"><div class="contents" style="flex-shrink:0.01"></div><div class="t">a</div></div>',
  );
});
