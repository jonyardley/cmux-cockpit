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

  it("does nothing when cmux reports a drag or a drop, so the rows keep their order", () => {
    // The fake Reorderable keeps no handlers, so stand a capturing one in for this build.
    const real = Reorderable;
    let hooks: Pick<ReorderableOptions<unknown>, "onMove" | "onDragChange"> | undefined;
    Object.assign(globalThis, {
      Reorderable: <T>(opts: ReorderableOptions<T>, render: (item: () => T) => View): View => {
        hooks = { onMove: opts.onMove, onDragChange: opts.onDragChange };
        return real(opts, render);
      },
    });
    const rows = [{ id: "a" }, { id: "b" }];
    try {
      motionList({ items: () => rows, key: (x) => x.id, spacing: 2 }, (x) => Text(x().id));
    } finally {
      Object.assign(globalThis, { Reorderable: real });
    }
    assert.ok(hooks);
    const before = r.calls.length;
    assert.equal(hooks.onDragChange({ id: "b", index: 0 }), undefined);
    assert.equal(hooks.onMove("b", 0), undefined);
    assert.equal(hooks.onDragChange(null), undefined);
    assert.deepEqual(rows, [{ id: "a" }, { id: "b" }]);
    assert.equal(r.calls.length, before);
  });
});
