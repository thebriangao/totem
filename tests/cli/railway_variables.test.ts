// The Railway deploy sets MCP_AUTH_TOKEN and the connector password on the
// service. They must not travel on the `railway` command line, where any local
// user can read them from `ps` while it runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { railwayVariableCommands, setRailwayVariables } from "../../src/cli/setup.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "Kq7m-Rt2x-Vb9n-Lp4w";
const ENV = { MCP_TRANSPORT: "http", MCP_AUTH_TOKEN: TOKEN, AUTH_PASSWORD: PASSWORD, PUBLIC_URL: "" };

afterEach(() => vi.restoreAllMocks());

describe("railwayVariableCommands", () => {
  const commands = railwayVariableCommands(ENV);

  it("keeps every secret value off the command line", () => {
    const argv = commands.flatMap((c) => c.args).join(" ");
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(PASSWORD);
  });

  it("feeds each secret on stdin, exactly, one variable per call", () => {
    expect(commands.slice(0, 2)).toEqual([
      { args: ["variable", "set", "MCP_AUTH_TOKEN", "--stdin", "--skip-deploys"], input: TOKEN },
      { args: ["variable", "set", "AUTH_PASSWORD", "--stdin", "--skip-deploys"], input: PASSWORD },
    ]);
  });

  it("sets the plain values last, in the one call that redeploys, and skips empty ones", () => {
    expect(commands.at(-1)).toEqual({ args: ["variable", "set", "MCP_TRANSPORT=http"] });
    expect(commands).toHaveLength(3);
  });

  it("lets the last secret trigger the deploy when there is nothing else to set", () => {
    expect(railwayVariableCommands({ A_TOKEN: "x", B_SECRET: "y" })).toEqual([
      { args: ["variable", "set", "A_TOKEN", "--stdin", "--skip-deploys"], input: "x" },
      { args: ["variable", "set", "B_SECRET", "--stdin"], input: "y" },
    ]);
  });
});

describe("setRailwayVariables", () => {
  type Call = { args: string[]; input?: string };
  const record = (answer: (args: string[]) => { code: number; stdout: string; stderr: string }) => {
    const calls: Call[] = [];
    const exec = async (_cmd: string, args: string[], opts: { cwd: string; input?: string }) => {
      calls.push(opts.input === undefined ? { args } : { args, input: opts.input });
      return answer(args);
    };
    return { calls, exec };
  };
  const ok = { code: 0, stdout: "", stderr: "" };

  it("runs the stdin commands and reports success", async () => {
    const { calls, exec } = record(() => ok);
    expect(await setRailwayVariables(ENV, "/app", exec)).toBe(true);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "variable set MCP_AUTH_TOKEN --stdin --skip-deploys",
      "variable set AUTH_PASSWORD --stdin --skip-deploys",
      "variable set MCP_TRANSPORT=http",
    ]);
    expect(calls[0]!.input).toBe(TOKEN);
  });

  it("stops and reports a failure without putting a secret on argv", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, exec } = record((args) => (args[2] === "AUTH_PASSWORD" ? { code: 1, stdout: "", stderr: "Failed to fetch: operation timed out" } : ok));
    expect(await setRailwayVariables(ENV, "/app", exec)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(PASSWORD);
    expect(log.mock.calls.flat().join("\n")).toContain("operation timed out");
  });

  it("falls back for a Railway CLI without `variable set --stdin`, and says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, exec } = record((args) => (args[0] === "variable" ? { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'set'" } : ok));
    expect(await setRailwayVariables(ENV, "/app", exec)).toBe(true);
    expect(calls.at(-1)!.args).toEqual(["variables", "--set", "MCP_TRANSPORT=http", "--set", `MCP_AUTH_TOKEN=${TOKEN}`, "--set", `AUTH_PASSWORD=${PASSWORD}`]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/can't read a value from stdin/);
  });
});
