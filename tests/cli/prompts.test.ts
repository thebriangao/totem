// What the prompts do when nobody is there to answer. No input is not consent:
// a question that gets end-of-input must stop the command, never take its
// default (`totem cloud < /dev/null` used to say yes to every deploy gate).
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputClosedError, prompt, promptChoice, promptHidden, promptYesNo, select } from "../../src/cli/ui.js";

/** A piped (non-TTY) stdin the test can write answers to, with stdout captured. */
function piped() {
  const input = Object.assign(new PassThrough(), { isTTY: false });
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { output.push(a.join(" ") + "\n"); });
  return { input, output };
}

afterEach(() => vi.restoreAllMocks());

describe("prompts at end of input", () => {
  it("a default-yes confirmation does not proceed", async () => {
    const { input } = piped();
    const answer = promptYesNo("Build + deploy to Fly now?", true);
    input.end();
    await expect(answer).rejects.toBeInstanceOf(InputClosedError);
  });

  it("names the question it stopped at", async () => {
    const { input } = piped();
    const answer = promptYesNo("Create a 1 GB volume?", true);
    input.end();
    await expect(answer).rejects.toMatchObject({ question: "Create a 1 GB volume?" });
  });

  it("a default-no confirmation, a text prompt, a menu and select all stop too", async () => {
    for (const ask of [
      () => promptYesNo("Install this older version anyway?", false),
      () => prompt("App name", "totem-abc123"),
      () => promptChoice("Where should the server run?", ["Fly.io", "Railway"]),
      () => select("Which client?", ["Claude Desktop", "Cursor"]),
    ]) {
      const { input } = piped();
      const answer = ask();
      input.end();
      await expect(answer).rejects.toBeInstanceOf(InputClosedError);
      vi.restoreAllMocks();
    }
  });

  it("stops at the first unanswered question after the piped answers run out", async () => {
    const { input } = piped();
    input.end("y\n");
    expect(await promptYesNo("First?", false)).toBe(true);
    await expect(promptYesNo("Second?", true)).rejects.toBeInstanceOf(InputClosedError);
  });

  it("a hidden prompt answers empty, which its callers treat as nothing entered", async () => {
    const { input } = piped();
    const answer = promptHidden("MCP_AUTH_TOKEN (hidden)");
    input.end();
    expect(await answer).toBe("");
  });
});

describe("prompts with piped answers", () => {
  it("Enter alone still takes the default", async () => {
    const { input } = piped();
    input.write("\n\n\n\n");
    expect(await promptYesNo("Proceed?", true)).toBe(true);
    expect(await promptYesNo("Risky?", false)).toBe(false);
    expect(await prompt("App name", "totem-abc123")).toBe("totem-abc123");
    expect(await promptChoice("Host?", ["Fly.io", "Railway"])).toBe(0);
    input.destroy();
  });

  // Each question used to open its own readline, which read ahead and took the
  // lines meant for the questions after it.
  it("answers piped in one write reach the questions in order", async () => {
    const { input } = piped();
    input.write("n\n2\nmy-app\n secret with spaces \ny\n");
    expect(await promptYesNo("Reuse it?", true)).toBe(false);
    expect(await promptChoice("Host?", ["Fly.io", "Railway", "Cloud Run"])).toBe(1);
    expect(await prompt("App name", "totem-abc123")).toBe("my-app");
    expect(await promptHidden("Token")).toBe(" secret with spaces ");
    expect(await promptYesNo("Deploy?", false)).toBe(true);
    input.destroy();
  });

  it("shows the question and never echoes a hidden answer", async () => {
    const { input, output } = piped();
    input.write("hunter2-hunter2\n");
    await promptHidden("Token");
    expect(output.join("")).toContain("Token");
    expect(output.join("")).not.toContain("hunter2");
    input.destroy();
  });
});
