// Golden JSON for the lanes scene: what the cockpit model computes from it,
// for the native core to match. See test/support/golden.ts.

import { goldenTest } from "./support/golden.ts";

await goldenTest("lanes");
