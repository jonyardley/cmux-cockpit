// npm run doctor: read-only checks on an install, a tick or a cross each,
// with the one line that fixes a cross. Exits 1 only when Node, cmux or the
// build fails; the other checks are the optional extras.

import { exitCode, report, runChecks } from "./setup/doctor-checks.ts";
import { realEnv } from "./setup/env.ts";

const checks = runChecks(realEnv());
for (const line of report(checks)) console.log(line);
process.exit(exitCode(checks));
