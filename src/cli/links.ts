// Opening a page in the person's browser, only when they say so.
//
// Their default browser may be signed in to the wrong account: with several
// Chrome profiles, a link opens in whichever profile was used last, and a
// sign-in there can land in an account that has no Cloudflare, Fly or claude.ai.
// So totem shows the link in full and asks first. Enter opens it; "n" leaves it
// to copy into the browser they want. Without anyone to ask (input isn't a
// terminal), the link is only shown.
//
// Not for the WHOOP login: that opens its own temporary Chrome window
// (browser_login.ts), which no account is signed in to.
import type { Io } from "./sys.js";

/** What became of an offered link. "withdrawn": something else settled it before an answer came. */
export type Offered = "opened" | "left" | "withdrawn";

const QUESTION = "Open it in your browser?";

/**
 * Show `url` under `label` and open it on a yes. With `until`, the question is
 * taken back when that signal aborts first (a sign-in that finished from the
 * link pasted elsewhere).
 */
export async function offerLink(io: Io, label: string, url: string, until?: AbortSignal): Promise<Offered> {
  const { ui, sys } = io;
  ui.lines(ui.kit.mark("info", label));
  // On a line of its own and never wrapped by totem: a terminal's own soft
  // wrap still copies as one line.
  ui.line(`  ${ui.kit.c.link(url)}`);
  if (!ui.canAsk) {
    ui.hint("Open it in your browser.", 2);
    return "left";
  }
  const yes = until ? await ui.confirmUntil(QUESTION, until) : await ui.confirm(QUESTION);
  if (yes === null) return "withdrawn";
  if (!yes) {
    ui.hint("Copy the link above into the browser you want to use.", 2);
    return "left";
  }
  sys.openUrl(url);
  ui.ok("Opened it in your browser");
  return "opened";
}
