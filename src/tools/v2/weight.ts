import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { WeightOut } from "../../schemas/weight.js";
import { projectWeightReadings, WEIGHT_COLUMNS, weightRows } from "../../projections/weight_readings.js";
import { WEIGHT_READINGS_PATH } from "../../lib/weight_readings.js";
import { toolError } from "../../lib/health_plans_write.js";

/** One WHOOP page of readings: the first, or the one after `token` (an opaque next_token). */
export function fetchWeightPage(client: WhoopClient, token?: string, fresh = false): Promise<unknown> {
  return token
    ? client.get(`${WEIGHT_READINGS_PATH}/paginated`, { next_token: token }, { fresh })
    : client.get(WEIGHT_READINGS_PATH, {}, { fresh });
}

// Totem's cursor = WHOOP's page token (verbatim) + an offset into that page, since
// a WHOOP page (~100 readings) is far more than a default answer needs.
interface Cursor { t?: string; o: number }
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
export function decodeCursor(s: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (typeof c.o !== "number" || c.o < 0 || (c.t !== undefined && typeof c.t !== "string")) return null;
    return c;
  } catch {
    return null;
  }
}

export function registerWeight(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_weight",
    description:
      "Weight and body-composition readings, newest first, in kg (display_unit is the account's unit). The newest reading is the " +
      "profile weight. Ids feed whoop_weight_log.",
    input: {
      limit: z.number().int().min(1).max(100).default(10),
      cursor: z.string().min(1).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ limit, cursor }) => {
    const pos = cursor ? decodeCursor(cursor) : { o: 0 };
    if (!pos) return toolError("Invalid cursor; pass next_cursor exactly as returned.");
    const n = limit ?? 10;
    const page = projectWeightReadings(await fetchWeightPage(client, pos.t));
    const rows = page.readings.slice(pos.o, pos.o + n);
    const next = pos.o + n < page.readings.length
      ? encodeCursor({ ...(pos.t ? { t: pos.t } : {}), o: pos.o + n })
      : page.next_token ? encodeCursor({ t: page.next_token, o: 0 }) : null;
    return respond("whoop_weight", WeightOut, {
      display_unit: page.display_unit,
      columns: [...WEIGHT_COLUMNS],
      rows: weightRows(rows),
      next_cursor: next,
    });
  });
}
