// npm run uninstall: takes out what setup's extras added, each confirmed,
// with backups first: the helper app, the automations link (only when it
// points here, putting the old file back) and only the cockpit's own
// Claude Code hooks. It never deletes the clone; it prints the
// quickstart's commands for that instead.
//
//   npm run uninstall              # asks before each step
//   npm run uninstall -- --yes     # no questions

import { uninstall } from "./setup/commands.ts";
import { realEnv } from "./setup/env.ts";

process.exit(await uninstall(realEnv(), process.argv.slice(2)));
