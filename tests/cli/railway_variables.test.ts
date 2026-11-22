// The Railway deploy sets MCP_AUTH_TOKEN and the connector password on the
// service. They must not travel on the `railway` command line, where any local
// user can read them from `ps` while it runs.
import { describe, expect, it } from "vitest";
import { railwayVariableCommands, setRailwayVariables } from "../../src/cli/setup.js";
import { render, SCREENS } from "./screens.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "Kq7m-Rt2x-Vb9n-Lp4w";
const ENV = { MCP_TRANSPORT: "http", MCP_AUTH_TOKEN: TOKEN, AUTH_PASSWORD: PASSWORD, PUBLIC_URL: "" };

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

describe("railwayIds", () => {
  it("finds the service's project, environment and service ids in railway status --json", async () => {
    const { railwayIds } = await import("../../src/cli/setup.js");
    const status = JSON.stringify({ id: "p1", environments: { edges: [{ node: { id: "e1", name: "production", serviceInstances: { edges: [{ node: { serviceId: "s1", serviceName: "totem" } }] } } }] } });
    expect(railwayIds(status, "totem")).toEqual({ projectId: "p1", environmentId: "e1", serviceId: "s1" });
    expect(railwayIds(status, "other")).toBeNull();
    expect(railwayIds("not json", "totem")).toBeNull();
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
    expect((await setRailwayVariables(ENV, "/app", exec)).code).toBe(0);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "variable set MCP_AUTH_TOKEN --stdin --skip-deploys",
      "variable set AUTH_PASSWORD --stdin --skip-deploys",
      "variable set MCP_TRANSPORT=http",
    ]);
    expect(calls[0]!.input).toBe(TOKEN);
  });

  it("stops at a failure and returns it, without putting a secret on argv", async () => {
    const { calls, exec } = record((args) => (args[2] === "AUTH_PASSWORD" ? { code: 1, stdout: "", stderr: "Failed to fetch: operation timed out" } : ok));
    const result = await setRailwayVariables(ENV, "/app", exec);
    expect(result).toMatchObject({ code: 1, stderr: "Failed to fetch: operation timed out" });
    expect(calls).toHaveLength(2);
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(PASSWORD);
  });

  it("falls back for a Railway CLI without `variable set --stdin`, and says so", async () => {
    const { calls, exec } = record((args) => (args[0] === "variable" ? { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'set'" } : ok));
    let told = 0;
    expect((await setRailwayVariables(ENV, "/app", exec, () => { told++; })).code).toBe(0);
    expect(calls.at(-1)!.args).toEqual(["variables", "--set", "MCP_TRANSPORT=http", "--set", `MCP_AUTH_TOKEN=${TOKEN}`, "--set", `AUTH_PASSWORD=${PASSWORD}`]);
    expect(told).toBe(1);
  });
});

// The whole Railway flow with a fake host: what `totem cloud` actually runs.
describe("totem cloud on Railway", () => {
  it("passes no secret on any command line", async () => {
    const { commands, code } = await render(SCREENS.find((s) => s.name === "cloud-railway")!);
    expect(code).toBe(0);
    const railway = commands.filter((c) => c.includes(" railway "));
    expect(railway).toContain("exec  railway variable set MCP_AUTH_TOKEN --stdin --service totem --skip-deploys  <stdin>");
    expect(railway).toContain("exec  railway variable set AUTH_PASSWORD --stdin --service totem --skip-deploys  <stdin>");
    // Every command names the service: \`railway up\` doesn't link the one it makes.
    for (const line of railway.filter((c) => /railway (up|domain|volume|variable)/.test(c))) expect(line).toContain("--service totem");
    for (const line of commands) expect(line).not.toMatch(/MCP_AUTH_TOKEN=|AUTH_PASSWORD=|a1b2c3d4e5f6a7b8|Kq7m-Rt2x/);
  });
});
