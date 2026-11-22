// Runs a browser login that never completes, as its own process, so
// browser_login_flow.test.ts can terminate it the way a closed terminal or a
// `kill` would and look at what is left behind.
//
//   node --import tsx browser_login_runner.ts <browser executable>
import { captureBrowserLogin } from "../../../src/cli/browser_login.js";

captureBrowserLogin({ browser: { name: "Fake", path: process.argv[2]! }, pollMs: 20, timeoutMs: 60_000 })
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
