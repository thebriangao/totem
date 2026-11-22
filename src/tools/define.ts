// One registration path for every v2 tool: description, zod input shape, MCP
// annotations, and a handler that returns a zod-validated projection as JSON text.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { WhoopProjectionError } from "../whoop/errors.js";
import { jsonOut } from "../whoop/json_out.js";
import { timezoneSettled } from "../whoop/init_timezone.js";

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
    // On a UTC host the member's timezone is looked up from their profile at
    // boot; a handler that ran before it landed read "today" off the UTC clock.
    // This resolves at once except during the first seconds after a cold start.
    // The SDK's callback typing is generic over the shape; the cast keeps each
    // tool's handler typed by its own zod shape.
    (async (args: z.infer<z.ZodObject<Shape>>) => {
      await timezoneSettled();
      return handler(args);
    }) as never,
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
