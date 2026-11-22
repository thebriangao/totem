// Stand-in for the MCP server under `totem start`: stays alive until it is
// signalled, and records which signal reached it.
//
//   node signal_child.mjs <state dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
for (const signal of ["SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    writeFileSync(join(dir, "signal"), signal);
    process.exit(0);
  });
}
writeFileSync(join(dir, "child.pid"), String(process.pid));
setInterval(() => {}, 1000);
