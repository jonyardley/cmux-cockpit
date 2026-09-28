// A temp home for npm run setup, doctor and uninstall's tests, with the
// checkout at ~/.config/cmux inside it, and a fake runner that records each
// command and answers from a table. Nothing here touches the real home, the
// real cmux, gh or Launch Services.

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env, Runner, RunResult } from "../../scripts/setup/env.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export interface Fake {
  env: Env;
  /** Each command run, as "cmd arg arg". */
  calls: string[];
  /** Everything printed. */
  out: string[];
  /** Questions asked, in order. */
  asked: string[];
}

export const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "", missing: false });
export const failed = (stderr = "failed"): RunResult => ({ status: 1, stdout: "", stderr, missing: false });
export const notFound: RunResult = { status: null, stdout: "", stderr: "", missing: true };

/** Answers for a command line (as "cmd arg arg"); the first key it starts with wins, anything else succeeds silently. */
export type Answers = Record<string, RunResult>;

/** A temp home with a checkout at ~/.config/cmux holding the committed files setup reads. */
export function tempHome(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "setup-home-"));
  const repo = join(home, ".config", "cmux");
  for (const dir of ["config", "node_modules", "src/shared", "sidebars", "scripts"]) {
    mkdirSync(join(repo, dir), { recursive: true });
  }
  for (const f of ["cmux.example.json", "automations.json", "config/projects.example.json"]) {
    copyFileSync(join(ROOT, f), join(repo, f));
  }
  writeFileSync(join(repo, "src", "shared", "a.ts"), "export {};\n");
  return { home, repo };
}

export function fakeEnv(
  where: { home: string; repo: string },
  answers: Answers = {},
  opts: { interactive?: boolean; reply?: boolean; node?: string } = {},
): Fake {
  const calls: string[] = [];
  const out: string[] = [];
  const asked: string[] = [];
  const run: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    return key === undefined ? ok() : (answers[key] ?? ok());
  };
  const env: Env = {
    home: where.home,
    repo: where.repo,
    run,
    print: (line) => out.push(line),
    ask: async (q) => {
      asked.push(q);
      return opts.reply ?? false;
    },
    interactive: opts.interactive ?? false,
    nodeVersion: opts.node ?? "24.2.0",
    now: () => new Date(2026, 8, 28, 14, 5, 2),
  };
  return { env, calls, out, asked };
}
