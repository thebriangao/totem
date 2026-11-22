// Kept for anyone who runs `node dist/scripts/cognito_bootstrap.js` directly:
// it is `totem auth` now (browser login; see src/cli/auth.ts). The v1
// USER_PASSWORD_AUTH + SMS flow is gone: WHOOP requires a SEON device
// fingerprint with it, so a correct password fails (issue #38).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAuth } from "../cli/auth.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.exit(await runAuth(ROOT, process.argv.slice(2)));
