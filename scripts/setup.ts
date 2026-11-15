// npm run setup: the quickstart's steps after npm ci, done for you and safe
// to run again (docs/quickstart.md). It never overwrites a file you have,
// backs up anything it replaces, asks before each optional extra, and ends
// with npm run doctor's report.
//
//   npm run setup                          # asks about each extra on a terminal
//   npm run setup -- --no-extras           # the main steps only
//   npm run setup -- --yes                 # every extra, no questions
//   npm run setup -- --helper --hooks      # just these extras, no questions

// No import.meta.main guard: on a Node too old to have it the script would
// silently do nothing, where this way the preflight says Node is too old.

import { setup } from "./setup/commands.ts";
import { realEnv } from "./setup/env.ts";

process.exit(await setup(realEnv(), process.argv.slice(2)));
