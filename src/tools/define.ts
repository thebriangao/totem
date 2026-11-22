// One registration path for every v2 tool: description, zod input shape, MCP
// annotations, and a handler that returns a zod-validated projection as JSON text.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { WhoopProjectionError } from "../whoop/errors.js";
import { jsonOut } from "../whoop/json_out.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface ToolSpec<Shape extends z.ZodRawShape> {
  name: `whoop_${string}`;
  description: string;
  input: Shape;
  annotations: ToolAnnotations;
}

export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
): void {
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
    // The SDK's callback typing is generic over the shape; the cast keeps each
    // tool's handler typed by its own zod shape.
    handler as never,
  );
}

/** Validate a projection against its output schema and wrap it as tool output. */
export function respond<S extends z.ZodTypeAny>(
  tool: string,
  schema: S,
  value: unknown,
  options: { compact?: boolean } = {},
): ToolResult {
  try {
    const out = schema.parse(value);
    return { content: [{ type: "text", text: jsonOut(out, options) }] };
  } catch (e) {
    if (e instanceof z.ZodError) throw new WhoopProjectionError(tool, e);
    throw e;
  }
}
