import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  password: vi.fn(),
  bootstrap: vi.fn(),
}));
vi.mock("dotenv/config", () => ({}));
vi.mock("../../src/cli/ui.js", () => ({
  prompt: vi.fn(),
  promptHidden: mocks.password,
}));
vi.mock("../../src/whoop/cognito.js", () => ({
  bootstrapCognito: mocks.bootstrap,
  refreshCognitoSession: vi.fn(),
}));

let directory: string;
const stopped = new Error("test intercepted process.exit");
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "totem-auth-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.spyOn(process, "exit").mockImplementation(() => { throw stopped; });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("WHOOP_EMAIL", "dummy@example.invalid");
  vi.stubEnv("WHOOP_PASSWORD", "");
  vi.stubEnv("WHOOP_AUTH_TOKENS_ONLY", "1");
  vi.stubEnv("FLY_APP", "");
  writeFileSync(join(directory, ".env"), "WHOOP_EMAIL=dummy@example.invalid\n");
  mocks.password.mockResolvedValue("Dummy#Value!");
  mocks.bootstrap.mockImplementation(async () => {
    expect(readFileSync(join(directory, ".env"), "utf8")).not.toContain("WHOOP_PASSWORD");
    throw new Error("Mock authentication rejection");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function rejectedLogin() {
  await expect(import("../../src/scripts/cognito_bootstrap.js")).rejects.toBe(stopped);
}

describe("one-time WHOOP password", () => {
  it("never saves a prompted password, including after rejection", async () => {
    await rejectedLogin();
    expect(mocks.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ password: "Dummy#Value!" }));
    expect(readFileSync(join(directory, ".env"), "utf8")).not.toContain("WHOOP_PASSWORD");
  });

  it("consumes a legacy saved password once and prompts on retry", async () => {
    writeFileSync(join(directory, ".env"), "WHOOP_EMAIL=dummy@example.invalid\nWHOOP_PASSWORD=OldDummy!\n");
    await rejectedLogin();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.bootstrap).toHaveBeenLastCalledWith(expect.objectContaining({ password: "OldDummy!" }));
    vi.resetModules();
    await rejectedLogin();
    expect(mocks.password).toHaveBeenCalledOnce();
    expect(mocks.bootstrap).toHaveBeenLastCalledWith(expect.objectContaining({ password: "Dummy#Value!" }));
  });

  it("consumes an environment password without persisting it", async () => {
    vi.stubEnv("WHOOP_PASSWORD", "EnvironmentDummy!");
    await rejectedLogin();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ password: "EnvironmentDummy!" }));
    expect(process.env.WHOOP_PASSWORD).toBeUndefined();
  });
});
