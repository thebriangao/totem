// The CLI's subprocess runner as its own process, the way `totem start` wraps
// the server, so signal_forwarding.test.ts can signal the wrapper and see what
// becomes of the child.
//
//   node --import tsx signal_wrapper.ts <child script> <state dir> [cli]
//
// With `cli`, the wrapper also has the handler the real entry point installs
// (src/cli/index.ts): SIGINT ends the process at once with 130.
import { run } from "../../../src/cli/sys.js";

if (process.argv[4] === "cli") process.on("SIGINT", () => process.exit(130));
run(process.execPath, [process.argv[2]!, process.argv[3]!]).then((code) => process.exit(code));
