// One racer process for token_lock.test.ts: wait at the gate with the others,
// then try to take over the (stale) lock and report what this process believes.
//
//   node --import tsx lock_racer.ts <lock path> <gate path>
import { existsSync, writeFileSync } from "node:fs";
import { TokenLock } from "../../../src/whoop/token_lock.js";

const [lockPath, gate] = process.argv.slice(2) as [string, string];
const lock = new TokenLock({ path: lockPath });
writeFileSync(gate.replace(/\.go$/, `.ready.${process.pid}`), "");
while (!existsSync(gate)) { /* spin, so every racer starts within microseconds */ }
const result = lock.tryAcquire();
// Stay alive a moment (our pid must count as alive for the others), then say
// whether the lock file still names us.
setTimeout(() => {
  process.stdout.write(JSON.stringify({ acquired: result.acquired, stillOwner: result.acquired && lock.verify() }));
}, 250);
