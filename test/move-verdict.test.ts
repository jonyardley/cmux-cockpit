// The model's verdict on a reply (scripts/hooks/move-verdict.ts): the saved
// field, the model's answer, and writing it only onto the move it was
// started for. No test runs the real `claude`: the runner is faked.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { DescriptionRead } from "../scripts/hooks/description.ts";
import {
  applyVerdict,
  askModel,
  CHILD_ENV,
  childEnv,
  claudeArgs,
  isVerdictChild,
  jobOf,
  parseVerdict,
  REPLY_CAP,
  type RunResult,
  repliesOf,
  VERDICT_TIMEOUT_MS,
  type VerdictDeps,
  type VerdictTarget,
  verdictJob,
  verdictPrompt,
  verdictTarget,
  withVerdict,
} from "../scripts/hooks/move-verdict.ts";
import {
  applySet,
  emptyState,
  moveDescription,
  moveOfDescription,
  type SavedMove,
  withContext,
} from "../scripts/state-config.ts";

const WS = "11111111-2222-3333-4444-555555555555";
const MOVE: SavedMove = { text: "Say go and I'll push.", epoch: 100, session: "s-1", unlabelled: true };
const TARGET: VerdictTarget = { wsId: WS, epoch: 100, session: "s-1", text: "Say go and I'll push." };
const CONTEXT = { epoch: 90, used: 40 };

describe("the saved verdict", () => {
  it("round trips through the description and the saved map, both values", () => {
    for (const verdict of ["waits", "quiet"] as const) {
      const m: SavedMove = { ...MOVE, verdict };
      assert.deepEqual(moveOfDescription(withContext(moveDescription(m), CONTEXT)), m);
      const set = applySet(emptyState(), `moves.${WS}`, JSON.stringify(m));
      assert.ok(set.ok);
      assert.deepEqual(set.state.moves[WS], m);
    }
  });

  it("refuses a move whose verdict is anything else", () => {
    for (const bad of ['"maybe"', "true", "null", "1"]) {
      assert.equal(moveOfDescription(`go ⟦move {"epoch":1,"verdict":${bad}}⟧`), null, bad);
      const set = applySet(emptyState(), `moves.${WS}`, `{"text":"go","epoch":1,"verdict":${bad}}`);
      assert.equal(set.ok, false, bad);
    }
  });
});

const out = (v: unknown): string => JSON.stringify({ type: "result", is_error: false, ...(v as object) });

describe("reading the model's answer", () => {
  it("takes structured_output, else the result read as JSON", () => {
    assert.equal(parseVerdict(out({ structured_output: { waiting: true }, result: "" })), "waits");
    assert.equal(parseVerdict(out({ structured_output: { waiting: false } })), "quiet");
    assert.equal(parseVerdict(out({ result: '{"waiting":false}' })), "quiet");
    assert.equal(parseVerdict(out({ structured_output: { other: 1 }, result: '{"waiting":true}' })), "waits");
  });

  it("gives null for anything malformed or an error", () => {
    for (const bad of [
      "",
      "not json",
      out({ result: "yes" }),
      out({ result: '{"waiting":"yes"}' }),
      out({ structured_output: { waiting: 1 } }),
      out({ is_error: true, structured_output: { waiting: true } }),
      "[]",
    ])
      assert.equal(parseVerdict(bad), null, bad);
  });

  it("asks once, in the child's environment, with the timeout, and gives null on a timeout or a failure", () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv; ms: number }[] = [];
    const fake =
      (r: RunResult) =>
      (args: string[], env: NodeJS.ProcessEnv, ms: number): RunResult => {
        calls.push({ args, env, ms });
        return r;
      };
    const good = out({ structured_output: { waiting: true } });
    assert.equal(
      askModel("go?", fake({ status: 0, stdout: good, timedOut: false }), { CMUX_WORKSPACE_ID: WS }),
      "waits",
    );
    assert.equal(calls[0]?.ms, VERDICT_TIMEOUT_MS);
    assert.equal(calls[0]?.env[CHILD_ENV], "1");
    assert.equal(calls[0]?.env.CMUX_WORKSPACE_ID, undefined);
    assert.deepEqual(calls[0]?.args.slice(0, 3), ["-p", "--model", "haiku"]);
    assert.equal(askModel("go?", fake({ status: null, stdout: good, timedOut: true }), {}), null);
    assert.equal(askModel("go?", fake({ status: 1, stdout: good, timedOut: false }), {}), null);
    assert.equal(askModel("go?", fake({ status: 0, stdout: "oops", timedOut: false }), {}), null);
  });

  it("cuts a long reply to its end, inside the markers", () => {
    const reply = `${"a".repeat(REPLY_CAP)}THE END`;
    const prompt = verdictPrompt(reply);
    assert.ok(prompt.includes("THE END\nREPLY>>>"));
    assert.ok(!prompt.includes("a".repeat(REPLY_CAP)));
    assert.equal(claudeArgs(prompt).at(-1), prompt);
  });
});

describe("the child guard", () => {
  it("marks the model's process, which the move hook then skips", () => {
    assert.equal(isVerdictChild(childEnv({})), true);
    assert.equal(isVerdictChild({}), false);
    assert.equal(isVerdictChild({ [CHILD_ENV]: "0" }), false);
  });

  it("makes the move hook return at once in the model's process", () => {
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, ["scripts/hooks/report-move.ts"], { input: "not json", encoding: "utf8", env });
    const env = { ...process.env };
    delete env[CHILD_ENV];
    assert.match(run(env).stderr, /^report-move: /);
    assert.equal(run(childEnv(env)).stderr, "");
  });
});

describe("the run's arguments", () => {
  it("carry the target and the cut reply, and refuse anything else", () => {
    const target = verdictTarget(WS, MOVE);
    assert.deepEqual(target, TARGET);
    assert.deepEqual(jobOf(verdictJob(target, "go?")), { target, reply: "go?" });
    const { session: _, ...noSession } = TARGET;
    assert.deepEqual(verdictTarget(WS, { text: MOVE.text, epoch: 100 }), noSession);
    assert.equal(jobOf(verdictJob(target, "x".repeat(REPLY_CAP + 5)))?.reply.length, REPLY_CAP);
    for (const bad of [
      [],
      ["--replay", "{}"],
      ["--apply", "not json"],
      ["--apply", JSON.stringify({ target: { ...TARGET, wsId: "" }, reply: "x" })],
      ["--apply", JSON.stringify({ target: { ...TARGET, epoch: "1" }, reply: "x" })],
      ["--apply", JSON.stringify({ target: { ...TARGET, session: 3 }, reply: "x" })],
      ["--apply", JSON.stringify({ target: TARGET })],
    ])
      assert.equal(jobOf(bad), null, JSON.stringify(bad));
  });

  it("reads a replay file's replies, skipping lines that are not one", () => {
    const file = ['"first"', "", '{"text":"second"}', "nonsense", '{"other":1}', "3"].join("\n");
    assert.deepEqual(repliesOf(file), ["first", "second"]);
  });
});

describe("writing the verdict onto its move", () => {
  it("lands only on the same epoch, session and text", () => {
    assert.deepEqual(withVerdict(MOVE, TARGET, "quiet"), { ...MOVE, verdict: "quiet" });
    assert.equal(withVerdict({ ...MOVE, epoch: 101 }, TARGET, "quiet"), null);
    assert.equal(withVerdict({ ...MOVE, session: "s-2" }, TARGET, "quiet"), null);
    assert.equal(withVerdict({ ...MOVE, text: "Other." }, TARGET, "quiet"), null);
    assert.equal(withVerdict(null, TARGET, "quiet"), null);
  });

  function deps(description: string | null, saved?: SavedMove, opts: { mangle?: boolean; busy?: boolean } = {}) {
    let text = description;
    const writes: string[] = [];
    const saves: SavedMove[] = [];
    let builds = 0;
    const d: VerdictDeps = {
      read: (): DescriptionRead => (text === null ? { ok: false, why: "silent" } : { ok: true, text }),
      write: (_ws, next) => {
        writes.push(next);
        text = opts.mangle && writes.length === 1 ? next.slice(0, 20) : next;
        return true;
      },
      saved: () => saved,
      save: (_ws, m) => {
        saves.push(m);
        return { ok: true, changed: true };
      },
      build: () => {
        builds++;
      },
      locked: (_ws, body, busy) => (opts.busy ? busy() : body()),
    };
    return { d, writes, saves, builds: () => builds, text: () => text };
  }

  it("patches the description's move, keeping the context tail", () => {
    const before = withContext(moveDescription(MOVE), CONTEXT);
    const t = deps(before);
    assert.equal(applyVerdict(TARGET, "waits", t.d), "wrote the verdict to the description");
    assert.equal(t.text(), withContext(moveDescription({ ...MOVE, verdict: "waits" }), CONTEXT));
    assert.equal(t.saves.length, 0);
  });

  it("puts the description back when cmux changes it", () => {
    const before = moveDescription(MOVE);
    const t = deps(before, undefined, { mangle: true });
    assert.match(applyVerdict(TARGET, "waits", t.d), /put back/);
    assert.equal(t.text(), before);
  });

  it("patches the saved map's move when the description does not hold it, and rebuilds", () => {
    const t = deps("Jon's own words", MOVE);
    assert.equal(applyVerdict(TARGET, "quiet", t.d), "wrote the verdict to the saved map");
    assert.deepEqual(t.saves, [{ ...MOVE, verdict: "quiet" }]);
    assert.equal(t.builds(), 1);
    assert.equal(t.writes.length, 0);
  });

  it("writes nothing for a newer move, another session's, or other text", () => {
    for (const current of [
      { ...MOVE, epoch: 200 },
      { ...MOVE, session: "s-2" },
      { ...MOVE, text: "Other." },
    ]) {
      const t = deps(moveDescription(current), current);
      assert.equal(applyVerdict(TARGET, "quiet", t.d), "the move is gone or newer");
      assert.equal(t.writes.length + t.saves.length, 0);
    }
    const unread = deps(null, undefined);
    assert.equal(applyVerdict(TARGET, "quiet", unread.d), "the move is gone or newer");
  });

  it("writes nothing while the lock stays taken", () => {
    const t = deps(moveDescription(MOVE), MOVE, { busy: true });
    assert.equal(applyVerdict(TARGET, "quiet", t.d), "the description lock stayed taken");
    assert.equal(t.writes.length + t.saves.length, 0);
  });
});
