// Reading a Claude Code transcript from a hook: the file's tail as lines,
// and the main chat's reply in one of them. Used by report-move.ts.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isId } from "../state-config.ts";
import { field } from "./gh-command.ts";

interface Reply {
  uuid: string;
  epoch: number;
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) => (field(b, "type") === "text" && typeof field(b, "text") === "string" ? [field(b, "text")] : []))
    .join("\n\n");
}

/** The main chat's reply in one transcript line, or null for anything else. */
export function replyFrom(line: string): Reply | null {
  // Most lines are tool results; skip them before paying for a parse.
  if (!line.includes('"assistant"')) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (field(v, "type") !== "assistant" || field(v, "isSidechain") === true) return null;
  const uuid = field(v, "uuid");
  const epoch = Date.parse(String(field(v, "timestamp"))) / 1000;
  const text = textOf(field(field(v, "message"), "content"));
  if (typeof uuid !== "string" || !isId(uuid) || !Number.isFinite(epoch) || !text) return null;
  return { uuid, epoch: Math.floor(epoch), text };
}

/** A tail's lines, dropping the first when the read began mid-file and so mid-line. */
export function tailLines(text: string, midFile: boolean): string[] {
  const lines = text.split("\n");
  return midFile ? lines.slice(1) : lines;
}

/** The last `maxBytes` of the file, as lines. A short read is read on from where it stopped. */
export function readTail(path: string, maxBytes: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return tailLines(buf.subarray(0, got).toString("utf8"), start > 0);
  } finally {
    closeSync(fd);
  }
}

/** Blocks for `ms`: a hook runs as its own short process, so that is harmless. */
export const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
