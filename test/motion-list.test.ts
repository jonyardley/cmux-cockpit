// motionList: a Reorderable, for its row motion, that can never be dragged.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer, nodeOf } from "./support/renderer.ts";

const r = installRenderer();
const { motionList } = await import("../src/shared/ui.ts");

describe("motionList", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const list = nodeOf(motionList({ items: () => items, key: (x) => x.id, spacing: 2 }, (x) => Text(x().id)));

  it("is a Reorderable, so cmux fades and slides its rows", () => {
    assert.equal(list?.kind, "Reorderable");
    assert.deepEqual(list?.args, [{ spacing: 2 }]);
  });

  it("pins every row, so none can be dragged", () => {
    assert.equal(list?.children.length, 2);
    for (const row of list?.children ?? []) {
      assert.ok(row.mods.some((m) => m.name === "fixed"));
    }
  });

  it("does nothing when cmux reports a drag or a drop: no dispatch, and the rows keep their order", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const moving = nodeOf(motionList({ items: () => rows, key: (x) => x.id, spacing: 2 }, (x) => Text(x().id)));
    const { onMove, onDragChange, items } = moving?.handlers ?? {};
    assert.ok(typeof onMove === "function" && typeof onDragChange === "function" && typeof items === "function");
    const before = r.calls.length;
    onDragChange({ id: "b", index: 0 });
    onMove("b", 0);
    onDragChange(null);
    assert.equal(r.calls.length, before);
    assert.deepEqual(items(), [{ id: "a" }, { id: "b" }]);
  });
});
