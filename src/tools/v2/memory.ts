import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { MemoryOut } from "../../schemas/memory.js";
import { findCardContent, projectMemoryDetail, projectMemoryItems } from "../../projections/memory.js";
import { WhoopServerError } from "../../whoop/errors.js";

const TOOL = "whoop_memory";
export const CONTEXT_HUB = "/context-hub-bff/v1/context-hub";

export const memoryInput = {
  category: z.string().regex(/^[a-z][a-z_]{0,39}$/, "lower_snake_case category").default("timeline")
    .describe("timeline (all), goals, training, … any key from categories"),
  limit: z.number().int().min(1).max(100).default(10).describe("Max rows returned"),
  memory_id: z.uuid().optional().describe("Open one memory's detail (marks it seen in the app)"),
};

/** Fresh read of one category's raw items (the context hub is never cached). */
export function readMemoryRaw(client: WhoopClient, category: string): Promise<unknown> {
  return client.get(`${CONTEXT_HUB}/items`, { category }, { fresh: true });
}

export async function readMemoryItems(client: WhoopClient, category: string, limit?: number) {
  return projectMemoryItems(await readMemoryRaw(client, category), category, limit);
}

export function registerMemory(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: TOOL,
      description:
        "What WHOOP Coach remembers about you (its memory): rows of id, title, summary, ACTIVE/INACTIVE status and category (timeline only), with total; categories lists the keys that have items. memory_id opens one memory's detail (dates and related conversations), which marks it seen in the app, so only open it when asked. Memories can't be created here: the coach saves them from chats.",
      input: memoryInput,
      annotations: READ_ONLY,
    },
    async ({ category, limit, memory_id }) => {
      if (!memory_id) return respond(TOOL, MemoryOut, await readMemoryItems(client, category, limit));
      const [detail, timeline] = await Promise.all([
        client.get(`${CONTEXT_HUB}/context-detail/${memory_id}`, {}, { fresh: true }).catch((e: unknown) => {
          // A deleted id answers 500 HTML, not 404 (ai §2.11).
          if (e instanceof WhoopServerError) throw new Error(`No memory ${memory_id} (WHOOP answers 500 for deleted or unknown ids).`);
          throw e;
        }),
        readMemoryRaw(client, "timeline").catch(() => null),
      ]);
      return respond(TOOL, MemoryOut, projectMemoryDetail(detail, memory_id, findCardContent(timeline, memory_id)));
    },
  );
}
