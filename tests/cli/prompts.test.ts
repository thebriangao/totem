// What the prompts do when nobody is there to answer. No input is not consent:
// a question that gets end-of-input must stop the command, never take its
// default (`totem cloud < /dev/null` used to say yes to every deploy gate).
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputClosedError, PLAIN, Ui } from "../../src/cli/ui.js";

/** A piped (non-TTY) stdin the test can write answers to, with what the Ui shows captured. */
function piped() {
  const input = Object.assign(new PassThrough(), { isTTY: false });
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  const output: string[] = [];
  const ui = new Ui({ style: PLAIN, write: (t) => { output.push(t); }, writeErr: (t) => { output.push(t); }, live: false });
  return { input, output, ui };
}

afterEach(() => vi.restoreAllMocks());

describe("prompts at end of input", () => {
  it("a default-yes confirmation does not proceed", async () => {
    const { input, ui } = piped();
    const answer = ui.confirm("Deploy this?", true);
    input.end();
    await expect(answer).rejects.toBeInstanceOf(InputClosedError);
  });

  it("names the question it stopped at", async () => {
    const { input, ui } = piped();
    const answer = ui.confirm("Switch this install to local?", true);
    input.end();
    await expect(answer).rejects.toMatchObject({ question: "Switch this install to local?" });
  });

  it("a default-no confirmation, a text prompt and a menu all stop too", async () => {
    for (const ask of [
      (ui: Ui) => ui.confirm("Install 1.5.0 anyway?", false),
      (ui: Ui) => ui.text("Name", "totem-abc123"),
      (ui: Ui) => ui.select("Where should the server run?", [{ label: "Fly.io" }, { label: "Railway" }]),
    ]) {
      const { input, ui } = piped();
      const answer = ask(ui);
      input.end();
      await expect(answer).rejects.toBeInstanceOf(InputClosedError);
      vi.restoreAllMocks();
    }
  });

  it("stops at the first unanswered question after the piped answers run out", async () => {
    const { input, ui } = piped();
    input.end("y\n");
    expect(await ui.confirm("First?", false)).toBe(true);
    await expect(ui.confirm("Second?", true)).rejects.toBeInstanceOf(InputClosedError);
  });

  it("a hidden prompt answers empty, which its callers treat as nothing entered", async () => {
    const { input, ui } = piped();
    const answer = ui.hidden("MCP_AUTH_TOKEN");
    input.end();
    expect(await answer).toBe("");
  });
});

describe("prompts with piped answers", () => {
  it("Enter alone takes the default", async () => {
    const { input, ui } = piped();
    input.write("\n\n\n\n");
    expect(await ui.confirm("Proceed?", true)).toBe(true);
    expect(await ui.confirm("Risky?", false)).toBe(false);
    expect(await ui.text("Name", "totem-abc123")).toBe("totem-abc123");
    expect(await ui.select("Host?", [{ label: "Fly.io" }, { label: "Railway" }], 1)).toBe(1);
    input.destroy();
  });

  // Each question used to open its own readline, which read ahead and took the
  // lines meant for the questions after it.
  it("answers piped in one write reach the questions in order", async () => {
    const { input, ui } = piped();
    input.write("n\n2\nmy-app\n secret with spaces \nyes\n");
    expect(await ui.confirm("Reuse it?", true)).toBe(false);
    expect(await ui.select("Host?", [{ label: "Fly.io" }, { label: "Railway" }, { label: "Cloud Run" }])).toBe(1);
    expect(await ui.text("Name", "totem-abc123")).toBe("my-app");
    expect(await ui.hidden("Token")).toBe(" secret with spaces ");
    expect(await ui.confirm("Deploy?", false)).toBe(true);
    input.destroy();
  });

  it("shows the question and never echoes a hidden answer", async () => {
    const { input, output, ui } = piped();
    input.write("hunter2-hunter2\n");
    await ui.hidden("Token");
    expect(output.join("")).toBe("? Token (hidden): \n");
    input.destroy();
  });

  // A stray key is not consent either: only y/yes and n/no are answers.
  it("asks again for an answer that is neither yes nor no, then takes it as no", async () => {
    const { input, output, ui } = piped();
    input.write("x\nmaybe\ny\n");
    expect(await ui.confirm("Deploy this?", true)).toBe(true);
    expect(output.join("")).toContain("Answer y or n.");
    input.write("x\nx\nx\n");
    expect(await ui.confirm("Deploy this?", true)).toBe(false);
    input.destroy();
  });

  it("a menu asks again for a number that isn't on it", async () => {
    const { input, output, ui } = piped();
    input.write("9\n2\n");
    expect(await ui.select("Host?", [{ label: "Fly.io" }, { label: "Railway" }])).toBe(1);
    expect(output.join("")).toContain("Enter a number from 1 to 2.");
    input.destroy();
  });
});
