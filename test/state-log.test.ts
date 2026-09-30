import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isLiveCheckout, redrawLine } from "../scripts/state-log.ts";

describe("isLiveCheckout", () => {
  const home = mkdtempSync(join(tmpdir(), "state-log-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const live = join(home, ".config", "cmux");
  const worktree = join(home, "worktree");
  mkdirSync(join(live, "sidebars"), { recursive: true });
  mkdirSync(join(worktree, "sidebars"), { recursive: true });

  it("is true for the checkout cmux reads its sidebars from", () => {
    assert.equal(isLiveCheckout(live, home), true);
  });

  it("is true through a link to that checkout", () => {
    const link = join(home, "linked");
    symlinkSync(live, link);
    assert.equal(isLiveCheckout(link, home), true);
  });

  it("is false for a worktree, whose build cmux never loads", () => {
    assert.equal(isLiveCheckout(worktree, home), false);
  });

  it("is false for a folder with no sidebars", () => {
    assert.equal(isLiveCheckout(join(home, "nowhere"), home), false);
  });
});

describe("redrawLine", () => {
  it("names each sidebar a build rewrote", () => {
    assert.equal(redrawLine(["agents", "cockpit"]), "build: redrew agents, cockpit");
  });

  it("says so when a build rewrote none", () => {
    assert.equal(redrawLine([]), "build: redrew nothing");
  });
});
