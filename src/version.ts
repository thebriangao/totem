// The release, as the MCP server reports it to clients (serverInfo.version).
// A constant rather than a read of package.json, so the Cloudflare build (no
// file system) reports it too. tests/packaging.test.ts keeps it equal to
// package.json's version.
export const VERSION = "2.0.0";
