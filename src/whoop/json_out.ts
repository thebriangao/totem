// Compact JSON for MCP tool responses. v2 tools produce already-projected
// data, so no stripping is needed — just stringify.
export function jsonOut(data: unknown): string {
  return JSON.stringify(data);
}
