// Tool definitions are sent to the model on every turn, so their size is paid
// for constantly. zod's JSON Schema output and the SDK's listing carry noise a
// model never needs:
//   - a validation regex on every ISO date / date-time / uuid field (the
//     `format` keyword already says what it is);
//   - JavaScript's safe-integer bounds on every integer;
//   - a `$schema` URL on every tool;
//   - `default: false` / `default: []` (what an omitted flag or list means anyway);
//   - `minLength: 1` / `minItems: 1` / `exclusiveMinimum: 0` (nobody sends "",
//     [] or a weight of zero on purpose);
//   - `propertyNames: {type: "string"}` (JSON keys are always strings);
//   - literal unions spelled as `anyOf: [{const}, …]` (an `enum` says the same);
//   - `execution: {taskSupport: "forbidden"}` on every tool (the MCP default
//     when the field is absent).
// This strips those from the tools/list response. Validation is unchanged: the
// server still parses every call with the full zod schema, so anything dropped
// here is still enforced, with an error that says what was wrong.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Formats that fully describe the string; zod's regex for them adds nothing a model uses. */
const SELF_DESCRIBING_FORMATS = new Set(["date", "date-time", "time", "duration", "uuid"]);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

/** `anyOf: [{type, const}, …]` with one shared type → `{type, enum}`; otherwise null. */
function literalUnion(anyOf: unknown): { type: unknown; enum: unknown[] } | null {
  if (!Array.isArray(anyOf) || anyOf.length < 2) return null;
  const members = anyOf.filter(isObject);
  if (members.length !== anyOf.length) return null;
  const type = members[0]!.type;
  if (typeof type !== "string") return null;
  for (const m of members) {
    const keys = Object.keys(m);
    if (keys.length !== 2 || !("const" in m) || m.type !== type) return null;
  }
  return { type, enum: members.map((m) => m.const) };
}

export function slimSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => slimSchema(item)) as unknown as T;
  if (!isObject(schema)) return schema;
  const node = schema;
  const out: Record<string, unknown> = {};
  const formatted = typeof node.format === "string" && SELF_DESCRIBING_FORMATS.has(node.format);
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "pattern" && formatted) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "default" && (value === false || isEmptyArray(value))) continue;
    if ((key === "minLength" || key === "minItems") && value === 1) continue;
    if (key === "exclusiveMinimum" && value === 0) continue;
    if (key === "propertyNames" && isObject(value) && Object.keys(value).length === 1 && value.type === "string") continue;
    if (key === "anyOf") {
      const literals = literalUnion(value);
      if (literals) {
        Object.assign(out, literals);
        continue;
      }
    }
    // Under `properties` the keys are field names, not schema keywords: slim each
    // field's schema, but never drop a field because of what it's called.
    out[key] = key === "properties" && isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, field]) => [name, slimSchema(field)]))
      : slimSchema(value);
  }
  return out as T;
}

type ListedTool = { inputSchema: unknown; execution?: unknown } & Record<string, unknown>;

/** One listed tool, slimmed: its input schema, and `execution` when it only states the default. */
export function slimTool<T extends ListedTool>(tool: T): T {
  const { execution, ...rest } = tool;
  const defaultExecution = isObject(execution) && Object.keys(execution).length === 1 && execution.taskSupport === "forbidden";
  return {
    ...rest,
    ...(execution === undefined || defaultExecution ? {} : { execution }),
    inputSchema: slimSchema(tool.inputSchema),
  } as unknown as T;
}

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: ListedTool[] } & Record<string, unknown>>;

/**
 * Wrap the SDK's tools/list handler so every listed tool is slimmed. Call it
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
    return { ...result, tools: result.tools.map(slimTool) } as never;
  });
  return true;
}
