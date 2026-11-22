import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { RawOut } from "../../schemas/escape.js";
import { preview } from "../../whoop/write_safety.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE, openWorld } from "../annotations.js";

/** Smart-alarm goals WHOOP can read back. Others it accepts, then 500s on forever (SPEC.md §7). */
export const SAFE_ALARM_GOALS = [
  "EXACT_TIME_PERFORM", "EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP", "IN_THE_GREEN",
  "SLEEP_HEALTH_PEAK", "SLEEP_HEALTH_PERFORM", "SLEEP_HEALTH_GET_BY",
] as const;

/**
 * Writes whoop_raw refuses even with allow_write (D14). Same categories as the
 * probe blocklist minus social (D9: social writes are allowed here, explicitly).
 */
const WRITE_DENYLIST: ReadonlyArray<[RegExp, string]> = [
  [/^\/auth-service\//, "auth is handled by totem itself"],
  [/(password|e-?mail|mfa|\/phone|verif|otp|logout|log-out|sign-?out|revoke|\/sessions?\b|deactivat|delete-account|account-deletion|close-account)/i, "could lock you out of your account"],
  [/^\/users-service\/v\d+\/users\/?$/, "account deletion"],
  [/^\/(commerce-service|order-service|rma-service|referral-service|membership-service|advanced-labs-service|growth-content-service|payment-service|checkout-service|billing-service)\//, "purchases, membership or orders"],
  [/(consent|\/terms|agreement|clinical|research|access_care|access_product)/i, "consents and legal agreements"],
  [/^\/(integrations-bff|integrations-service|social-service)\//, "third-party account connections"],
  [/(strap|garment|pairing|firmware|\/device)/i, "the strap or device"],
  [/^\/(messaging-service)\//, "sends SMS or email"],
  [/^\/(sentry-proxy-service|metrics-service|mobile-metric-service|log-service|pip-metrics-service)\//, "telemetry"],
];

/**
 * The path WHOOP will route, for matching against the denylist: query and
 * fragment dropped, percent-decoded, duplicate slashes collapsed, lower-cased.
 * Null when the text doesn't say where the request lands (still-encoded
 * characters, "." or ".." segments, ";" path parameters, backslashes,
 * whitespace or control characters) — every one of those let a denylisted
 * endpoint through while the denylist matched the literal string.
 */
function routedPath(path: string): string | null {
  let routed = path.split(/[?#]/)[0]!;
  try {
    routed = decodeURIComponent(routed);
  } catch {
    return null;
  }
  if (/[%;\\\u0000- \u007f]/.test(routed)) return null;
  routed = routed.replace(/\/{2,}/g, "/");
  if (routed.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return routed.toLowerCase();
}

export function rawWriteRefusal(rawPath: string, body: unknown): string | null {
  const path = routedPath(rawPath);
  if (path === null) {
    return `whoop_raw won't write to ${JSON.stringify(rawPath)}: write paths must be plain (no percent-encoding, "." or ".." segments, ";", backslashes or whitespace) so they can be checked. Put parameters in \`query\`.`;
  }
  for (const [re, why] of WRITE_DENYLIST) if (re.test(path)) return `whoop_raw won't write to ${rawPath}: ${why}.`;
  if (path.startsWith("/smart-alarm-service/v1/smartalarm/preferences")) {
    const goal = (body as { goal?: unknown } | null)?.goal;
    if (goal !== undefined && !(SAFE_ALARM_GOALS as readonly unknown[]).includes(goal)) {
      return `whoop_raw won't set Smart Alarm goal ${JSON.stringify(goal)}: WHOOP accepts some goals it can't read back, which breaks the alarm permanently. Allowed: ${SAFE_ALARM_GOALS.join(", ")}.`;
    }
  }
  return null;
}

export function registerRaw(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: "whoop_raw",
      description:
        "Escape hatch: call any WHOOP endpoint when no tool fits (the whoop://catalog/endpoints resource lists verified paths). GET by " +
        "default. Writes need allow_write:true and confirm:true; some paths are refused outright (auth, account, purchases, consents, " +
        "strap, telemetry). Social writes (follow, comment) are only available here.",
      input: {
        path: z.string().describe("e.g. /home-service/v1/home"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        allow_write: z.boolean().default(false),
        confirm: z.boolean().default(false),
      },
      annotations: openWorld(WRITE_DESTRUCTIVE),
    },
    async ({ path, method, query, body, allow_write, confirm }) => {
      const safePath = path.startsWith("/") ? path : `/${path}`;
      const q = query ?? {};
      if (method === "GET") {
        const response = await client.get(safePath, q);
        return respond("whoop_raw", RawOut, { path: safePath, method, status: 200, response }, { compact: false });
      }
      if (!allow_write) throw new Error("whoop_raw writes need allow_write:true (and confirm:true). Prefer a specific whoop_* tool if one fits.");
      const refusal = rawWriteRefusal(safePath, body);
      if (refusal) throw new Error(refusal);
      if (!confirm) return respond("whoop_raw", RawOut, preview(method, safePath, { query: q, body }));
      // The client invalidates dependent cache tags itself (everything for unknown paths).
      // The status is WHOOP's own (a delete usually answers 204 with no body), not an assumed 200.
      const { status, body: response } = await client.write(method, safePath, body, q);
      return respond("whoop_raw", RawOut, { path: safePath, method, status, response }, { compact: false });
    },
  );
}
