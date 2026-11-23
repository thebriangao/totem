// offerLink (src/cli/links.ts): totem opens a page in someone's browser only
// after a yes, because the default browser may be signed in to the wrong
// account. The WHOOP login's own temporary window is not affected.
import { afterEach, describe, expect, it } from "vitest";
import { offerLink } from "../../src/cli/links.js";
import { Ui } from "../../src/cli/ui.js";
import { fakeWorld, type FakeWorld, type WorldOptions } from "./helpers.js";

const LINK = "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d1&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread%20user%3Aread%20workers%3Awrite&state=abc&code_challenge=def&code_challenge_method=S256";
const QUESTION = "? Open it in your browser? (Y/n)";

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });
const start = (opts: WorldOptions = {}): FakeWorld => (world = fakeWorld(opts));

describe("offerLink", () => {
  it("shows the whole link on a line of its own, then opens it on Enter", async () => {
    const w = start();
    expect(await offerLink(w.io, "Cloudflare sign-in", LINK)).toBe("opened");
    expect(w.commands).toEqual([`open  ${LINK}`]);
    const text = w.transcript();
    // Never wrapped or shortened by totem, so it copies whole.
    expect(text).toContain(`\n  ${LINK}\n`);
    expect(text.indexOf(QUESTION)).toBeGreaterThan(text.indexOf(LINK));
    expect(text).toContain("Opened it in your browser");
  });

  it("leaves the link to copy when the answer is no", async () => {
    const w = start({ answers: [["Open it in your browser?", false]] });
    expect(await offerLink(w.io, "Your server's Connect page", "https://totem.example/connect")).toBe("left");
    expect(w.commands).toEqual([]);
    expect(w.transcript()).toContain("Copy the link above into the browser you want to use.");
  });

  it("only shows the link when nobody can answer", async () => {
    const w = start();
    const out: string[] = [];
    const ui = new Ui({ style: w.ui.style, write: (t) => { out.push(t); }, live: false, canAsk: false });
    expect(await offerLink({ ...w.io, ui }, "claude.ai with the server filled in", "https://claude.ai/x")).toBe("left");
    expect(w.commands).toEqual([]);
    expect(out.join("")).toContain("https://claude.ai/x");
    expect(out.join("")).not.toContain("Open it in your browser? (Y/n)");
  });

  it("takes the question back when the sign-in finished first (the link was pasted elsewhere)", async () => {
    const w = start();
    const done = new AbortController();
    done.abort();
    expect(await offerLink(w.io, "Cloudflare sign-in", LINK, done.signal)).toBe("withdrawn");
    expect(w.commands).toEqual([]);
    expect(w.transcript()).not.toContain(QUESTION);
  });
});
