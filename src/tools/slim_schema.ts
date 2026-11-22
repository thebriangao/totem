// Tool definitions are sent to the model on every turn, so their size is paid
// for constantly. zod's JSON Schema output carries noise a model never needs:
//   - a ~330-character validation regex on every ISO date / date-time field
//     (the `format` keyword already says what it is);
//   - JavaScript's safe-integer bounds on every integer;
//   - a `$schema` URL on every tool.
// This strips those from the tools/list response. Validation is unchanged: the
// server still parses every call with the full zod schema.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DATE_FORMATS = new Set(["date", "date-time", "time", "duration"]);

export function slimSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => slimSchema(item)) as unknown as T;
  if (schema === null || typeof schema !== "object") return schema;
  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const dated = typeof node.format === "string" && DATE_FORMATS.has(node.format);
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "pattern" && dated) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    out[key] = slimSchema(value);
  }
  return out as T;
}

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: Array<{ inputSchema: unknown }> } & Record<string, unknown>>;

/**
 * Wrap the SDK's tools/list handler so every listed schema is slimmed. Call it
 * after all tools are registered. If the SDK's internals move (the handler map
 * is not public API), this does nothing and the full schemas are served; the
 * registry test fails in that case, so it can't regress unnoticed.
 */
export function installSlimToolList(server: McpServer): boolean {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!original) return false;
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request, extra);
    return { ...result, tools: result.tools.map((tool) => ({ ...tool, inputSchema: slimSchema(tool.inputSchema) })) } as never;
  });
  return true;
}
