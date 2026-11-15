// How a hook calls the cmux CLI: the binary cmux's own Claude hooks use
// when it names one, a five-second limit, and cmux's chatter off.

import { spawnSync } from "node:child_process";

export function cmux(args: string[]): { ok: boolean; out: string; err: string } {
  const bin = process.env.CMUX_CLAUDE_HOOK_CMUX_BIN || "cmux";
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: 5000, env: { ...process.env, CMUX_QUIET: "1" } });
  return { ok: res.status === 0, out: res.stdout ?? "", err: (res.stderr || res.error?.message || "").trim() };
}
