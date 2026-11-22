// WHOOP.md: what is known about WHOOP's app API, written from totem's own
// endpoint catalog (src/data/endpoint_catalog.ts, generated from the November
// 2026 probe) so the reference can't drift from the code.
// tests/tools/whoop_md.test.ts fails when it is stale.
//
//   npx tsx scripts/whoop-md.ts > WHOOP.md
import { ENDPOINT_CATALOG, type EndpointEntry } from "../src/data/endpoint_catalog.js";
import { IOS_APP_VERSION } from "../src/whoop/device.js";

const AREAS: Record<string, string> = {
  home: "Home, deep dives and calendar",
  activities: "Activities and cycles",
  sleep: "Sleep",
  trends: "Trends and heart rate",
  strength: "Strength Trainer",
  journal: "Journal",
  ai: "WHOOP Coach",
  memory: "Coach memory",
  womens_health: "Cycle tracking (Hormonal Insights)",
  weekly_plan: "Weekly Plan",
  smart_alarm: "Smart Alarm",
  milestones: "Milestones and streaks",
  settings: "Profile and settings",
  privacy: "Privacy",
  integrations: "Integrations",
  community: "Community",
  health: "Health Monitor",
  developer: "Developer API (the public API's v2 paths, readable with an app token)",
  auth: "Sign-in",
  misc: "Other",
};

const VERDICTS: Array<[string, string]> = [
  ["verified", "Worked live; writes were read back."],
  ["verified-quirky", "Works, with a catch described in the notes."],
  ["decided", "A design decision rather than a probe result (see the notes)."],
  ["exists-but-unclear", "Answers, but no request shape that does something useful was found."],
  ["not-exercised", "Seen in the app but deliberately not called."],
  ["not-probed", "Known but not called in this run."],
  ["blocked-by-policy", "Left alone on purpose (it would change something that can't be undone)."],
  ["service-only-401", "Answers 401 to an app token: for WHOOP's own services."],
  ["server-error-500", "Answers 500 whatever is sent."],
  ["not-found", "Answers 404: gone, or never existed at that path."],
];

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const usable = (e: EndpointEntry): boolean => e.verdict.startsWith("verified") || e.verdict === "decided";

export function whoopMarkdown(): string {
  const out: string[] = [
    "# WHOOP's app API",
    "",
    "What totem knows about the API the WHOOP app uses, as of November 2026. The tables below are written from totem's own endpoint catalog (`src/data/endpoint_catalog.ts`) by `npx tsx scripts/whoop-md.ts`, so they match what the code was built against.",
    "",
    "This is an unofficial description of a private API. WHOOP can change it at any time, and does.",
    "",
    "## How it was mapped",
    "",
    `- **Captures.** The WHOOP iOS app (${IOS_APP_VERSION}) was run through mitmproxy on two accounts, and every request was recorded.`,
    `- **A live probe.** Each of the ${ENDPOINT_CATALOG.length} endpoints below was then called on a test account through a proxy that paced requests to a person's speed and kept a record of every call. Writes were made, read back, and undone. Each endpoint got a verdict.`,
    "- **The heart-rate series and the bulk day history** were checked live the same day, including that another person's user id is refused.",
    "",
    "No real person's data appears in totem's tests or this page.",
    "",
    "## Basics",
    "",
    "- **Host:** `https://api.prod.whoop.com`. Every service sits under a path prefix (`/home-service/`, `/core-details-bff/`, `/weightlifting-service/` and so on).",
    "- **Auth:** a Cognito access token as a bearer token (about 24 hours). The token from a web login (app.whoop.com) works on the app API.",
    "- **Refresh:** `POST /auth-service/v3/whoop/` with the Cognito `InitiateAuth` call (`REFRESH_TOKEN_AUTH`, the web client's id). **WHOOP returns a new refresh token every time, and the old one stops working.** Save the new one before using the new access token, and never let two processes refresh the same login.",
    "- **Logging in** with a password now needs a device fingerprint from WHOOP's fraud check, which is why totem logs in through a real browser window instead.",
    "- **Headers:** the app's identity headers (platform, app version and build, bundle name), a stable per-install `x-whoop-installation-identifier`, `x-whoop-time-zone` (an IANA name) and `x-whoop-clock-format`. totem sends the same set the app does, minus telemetry.",
    "- **Errors worth knowing:** `401` means refresh and try once more; `412` (\"cycle is concurrently being updated\") on a write means wait and retry (totem waits 2 s, then 10 s); a `409` on an activity write means the time window overlaps another activity.",
    "- **Days are cycles.** A WHOOP day runs from falling asleep to falling asleep. Day endpoints take a calendar date and answer with the cycle that date belongs to, in the user's time zone.",
    "- **Units:** HRV comes in seconds from some endpoints and milliseconds from others; sleep durations in the bulk history are milliseconds. totem converts everything to ms, minutes, hours and °C/°F as its tools document.",
    "",
    "## Verdicts",
    "",
    "| Verdict | Meaning |",
    "|---|---|",
    ...VERDICTS.map(([v, m]) => `| \`${v}\` | ${m} |`),
    "",
    "## Endpoints by area",
    "",
    "`Used by` names the totem tools (or `whoop://catalog/...` resources) that call the endpoint. Paths are templated: `{user_id}`, `{date}` and the like stand for real values.",
  ];
  const domains = [...new Set(ENDPOINT_CATALOG.map((e) => e.domain))].sort((a, b) =>
    Object.keys(AREAS).indexOf(a) - Object.keys(AREAS).indexOf(b));
  for (const domain of domains) {
    const rows = ENDPOINT_CATALOG.filter((e) => e.domain === domain);
    const good = rows.filter(usable);
    const bad = rows.filter((e) => !usable(e));
    out.push("", `### ${AREAS[domain] ?? domain}`);
    if (good.length) {
      out.push("", "| Method | Path | Verdict | Used by | Notes |", "|---|---|---|---|---|");
      for (const e of good) out.push(`| ${e.method} | \`${cell(e.path)}\` | ${e.verdict} | ${cell(e.tools.join(", ")) || "–"} | ${cell(e.notes)} |`);
    }
    if (bad.length) {
      out.push("", good.length ? "Don't use:" : "Nothing here worked:", "", "| Method | Path | Verdict | Notes |", "|---|---|---|---|");
      for (const e of bad) out.push(`| ${e.method} | \`${cell(e.path)}\` | ${e.verdict} | ${cell(e.notes)} |`);
    }
  }
  const unknown = ENDPOINT_CATALOG.filter((e) => !VERDICTS.some(([v]) => v === e.verdict));
  if (unknown.length) throw new Error(`Unknown verdicts in the catalog: ${[...new Set(unknown.map((e) => e.verdict))].join(", ")}`);
  return out.join("\n") + "\n";
}

if (process.argv[1] && /whoop-md\.ts$/.test(process.argv[1])) {
  process.stdout.write(whoopMarkdown());
}
