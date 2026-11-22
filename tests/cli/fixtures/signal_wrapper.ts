// The CLI's subprocess runner as its own process, the way `totem start` wraps
// the server, so signal_forwarding.test.ts can signal the wrapper and see what
// becomes of the child.
//
//   node --import tsx signal_wrapper.ts <child script> <state dir>
import { run } from "../../../src/cli/sys.js";

run(process.execPath, [process.argv[2]!, process.argv[3]!]).then((code) => process.exit(code));
