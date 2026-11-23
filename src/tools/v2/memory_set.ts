import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { preview } from "../../whoop/write_safety.js";
import { MemorySetOut, type MemoryRowT, type MemorySetReceiptT } from "../../schemas/memory.js";
import { memoryEnabled } from "../../projections/memory.js";
import { CONTEXT_HUB, readMemoryItems } from "./memory.js";

const TOOL = "whoop_memory_set";
export const AI_SETTINGS = "/ai-conversation-service/v1/settings";
const MEMORY_OFF_WARNING =
  'With memory off the coach may still say it saved something ("Added your … goal"), but nothing is stored.';

export const memorySetInput = {
  action: z.enum(["activate", "deactivate", "delete", "enable_memory", "disable_memory"]),
  memory_id: z.uuid().optional().describe("From whoop_memory"),
  confirm: z.boolean().default(false),
};

/** Find a card without opening its detail (a read receipt): timeline first, then each category. */
export async function findMemory(client: WhoopClient, id: string): Promise<MemoryRowT | null> {
  const timeline = await readMemoryItems(client, "timeline");
  const hit = timeline.items.find((i) => i.id === id);
  if (hit) return hit;
  for (const key of timeline.categories.filter((k) => k !== "timeline")) {
    const found = (await readMemoryItems(client, key)).items.find((i) => i.id === id);
    if (found) return found;
  }
  return null;
}

function receipt(action: MemorySetReceiptT["action"]): MemorySetReceiptT {
  return { action, changed: false, memory: null, memory_enabled: null, verified: false, warnings: [] };
}

async function setMemorySwitch(client: WhoopClient, action: "enable_memory" | "disable_memory", confirm: boolean) {
  const active = action === "enable_memory";
  const before = memoryEnabled(await client.get(AI_SETTINGS, {}, { fresh: true }));
  const body = { setting_key: "WHOOP_COACH_MEMORY", active };
  if (!confirm) {
    return preview("PUT", AI_SETTINGS, { ...body, currently: before, note: active ? null : MEMORY_OFF_WARNING });
  }
  const out = receipt(action);
  if (before !== active) {
    await client.put(AI_SETTINGS, body);
    out.changed = true;
  } else {
    out.warnings.push(`Memory was already ${active ? "on" : "off"}; nothing was sent.`);
  }
  // Read back with a GET, not the PUT's echo (S14).
  out.memory_enabled = memoryEnabled(await client.get(AI_SETTINGS, {}, { fresh: true }));
  out.verified = out.memory_enabled === active;
  if (!out.verified) out.warnings.push(`WHOOP still reports memory ${out.memory_enabled ? "on" : "off"}.`);
  if (!active) out.warnings.push(MEMORY_OFF_WARNING);
  return out;
}

async function setMemoryItem(client: WhoopClient, action: "activate" | "deactivate" | "delete", id: string, confirm: boolean) {
  const card = await findMemory(client, id);
  if (!card) throw new Error(`No memory ${id} in your context hub. List them with whoop_memory.`);
  const path = `${CONTEXT_HUB}/context-detail/${id}`;
  const target = action === "activate" ? "ACTIVE" : "INACTIVE";
  if (!confirm) {
    if (action === "delete") return preview("DELETE", path, { memory: card, note: "Permanent: WHOOP can't restore it." });
    return preview("PUT", `${path}/status`, { target_state: target, memory: card });
  }
  const out = receipt(action);
  if (action === "delete") {
    await client.delete(path);
    out.changed = true;
  } else if (card.status !== target) {
    await client.put(`${path}/status`, { target_state: target });
    out.changed = true;
  } else {
    out.warnings.push(`It was already ${target}; nothing was sent.`);
  }
  // Read back from the cards (never the detail: that's a read receipt). A 204 proves nothing (S14).
  const after = await findMemory(client, id);
  out.memory = action === "delete" ? card : after;
  out.verified = action === "delete" ? after === null : after?.status === target;
  if (!out.verified) {
    out.warnings.push(action === "delete" ? "The memory is still listed after the delete." : `It reads back as ${after?.status ?? "missing"}.`);
  }
  return out;
}

export function registerMemorySet(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: TOOL,
      description:
        "Change what WHOOP Coach remembers: activate or deactivate a memory (inactive ones stop shaping coaching), delete one " +
        "permanently, or enable_memory / disable_memory for the whole account. With memory off nothing is stored, whatever the coach " +
        "says. Previews unless confirm:true.",
      input: memorySetInput,
      annotations: WRITE_DESTRUCTIVE,
    },
    async ({ action, memory_id, confirm }) => {
      if (action === "enable_memory" || action === "disable_memory") {
        if (memory_id) throw new Error(`${action} applies to the whole account; drop memory_id.`);
        return respond(TOOL, MemorySetOut, await setMemorySwitch(client, action, confirm));
      }
      if (!memory_id) throw new Error(`${action} needs memory_id (from whoop_memory).`);
      return respond(TOOL, MemorySetOut, await setMemoryItem(client, action, memory_id, confirm));
    },
  );
}
