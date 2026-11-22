// whoop_preferences_set (W!): reversible account toggles, one per call
// (SPEC.md §4.6 preferences/tracked set, §4.8 visibility and preferences, §7 S8).
// Replaces whoop_hidden_metric. Every write is read back fresh, except the
// clock format, which WHOOP has no user-token read for (GET → 401).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond, type ToolResult } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { PreferencesSetOut } from "../../schemas/settings_v2.js";
import { dashboardOptions, projectBehaviorToggles, projectDashboard, projectJournalPrefs, projectNotifications } from "../../projections/settings_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { asString, isObject } from "../../lib/walk.js";
import {
  CLOCK_FORMATS,
  GAUGE_METRICS,
  HIDDEN_METRICS,
  KEY_METRICS,
  NOTIFICATION_NAMESPACES,
  candidateTimeZone,
  normalizeOffset,
  zoneOffset,
} from "../../lib/profile_settings.js";
import { resolveBehavior, specFromTracker, type BehaviorCatalog, type BehaviorSpec } from "../../lib/journal_behaviors.js";
import { BEHAVIORS } from "../../data/behaviors.js";

const NAME = "whoop_preferences_set";
const SETTINGS = ["hidden_metric", "stealth", "dashboard", "notification", "journal_prefs", "tracked_behaviors", "clock_format"] as const;
type Setting = (typeof SETTINGS)[number];

const P = {
  hidden: (m: string) => `/users-service/v1/hidden-metrics/${m}`,
  stealth: "/users-service/v1/stealth-mode",
  dashboardRead: "/home-service/v2/home/dashboard/customize",
  dashboardWrite: "/user-preferences-service/v1/home/dashboard/customize",
  notificationsRead: "/notification-service/v1/notifications/user-settings/bff",
  block: "/notification-service/v1/notifications/user-settings/block/namespace",
  journalPrefs: "/journal-service/v1/journals/preferences",
  tracked: "/activities-service/v1/journals/behaviors/user",
  customize: "/journal-service/v3/journals/behaviors",
  bootstrap: "/users-service/v2/bootstrap",
  clock: "/users-service/v1/users/preferences/time",
};

/** Which inputs each setting takes; anything else is refused so a mixed-up call can't half-apply. */
const FIELDS: Record<Setting, { required: string[]; optional: string[] }> = {
  hidden_metric: { required: ["metric", "hidden"], optional: [] },
  stealth: { required: ["enabled"], optional: [] },
  dashboard: { required: [], optional: ["gauges", "pinned"] },
  notification: { required: ["namespace", "enabled"], optional: [] },
  journal_prefs: { required: [], optional: ["journal_enabled", "journal_autopop_enabled", "ai_autopop_enabled"] },
  tracked_behaviors: { required: [], optional: ["track", "untrack"] },
  clock_format: { required: ["clock_format"], optional: [] },
};

function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: jsonOut({ error, ...extra }) }], isError: true };
}

interface Plan {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body: unknown;
  before: unknown;
  /** What the setting should read back as. */
  target: unknown;
  noChange: boolean;
  readBack: (sendResult: unknown) => Promise<unknown>;
  /** Optional: shape the receipt's `after` from the read-back. */
  afterOut?: (after: unknown) => unknown;
  matches: (after: unknown) => boolean;
  warnings: string[];
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

export function registerPreferencesSet(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "WRITE: change one account setting. hidden_metric (metric, hidden), stealth (enabled), dashboard (gauges: exactly 2 focus metrics; pinned: the full ordered list; omitted ones are kept), notification (namespace, enabled), journal_prefs (any of the three flags), tracked_behaviors (track/untrack ids or names; untracking only hides a behaviour, its answers stay), clock_format. Reads the setting back; preview unless confirm:true.",
    input: {
      setting: z.enum(SETTINGS),
      metric: z.enum(HIDDEN_METRICS).optional(),
      hidden: z.boolean().optional().describe("hidden_metric: true hides it in the app."),
      enabled: z.boolean().optional().describe("stealth on/off; notification on (false blocks the namespace)."),
      namespace: z.enum(NOTIFICATION_NAMESPACES).optional(),
      gauges: z.array(z.enum(GAUGE_METRICS)).length(2).optional().describe("The two focus gauges beside Recovery and Strain."),
      pinned: z.array(z.enum(KEY_METRICS)).optional().describe("Dashboard metrics, in order (replaces the list)."),
      journal_enabled: z.boolean().optional(),
      journal_autopop_enabled: z.boolean().optional(),
      ai_autopop_enabled: z.boolean().optional(),
      track: z.array(z.union([z.number().int(), z.string()])).optional().describe("Behaviour ids or names to start tracking."),
      untrack: z.array(z.union([z.number().int(), z.string()])).optional().describe("Behaviour ids or names to stop tracking."),
      clock_format: z.enum(CLOCK_FORMATS).optional(),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    const { setting, confirm } = args;
    const given = Object.entries(args).filter(([k, v]) => v !== undefined && k !== "setting" && k !== "confirm").map(([k]) => k);
    const spec = FIELDS[setting];
    const foreign = given.filter((k) => !spec.required.includes(k) && !spec.optional.includes(k));
    if (foreign.length > 0) return fail(`${setting} doesn't take ${foreign.join(", ")}.`);
    const missing = spec.required.filter((k) => !given.includes(k));
    if (missing.length > 0) return fail(`${setting} needs ${missing.join(", ")}.`);
    if (spec.required.length === 0 && given.length === 0) return fail(`${setting} needs at least one of ${spec.optional.join(", ")}.`);

    let plan: Plan | ToolResult;
    switch (setting) {
      case "hidden_metric": plan = await planHidden(client, args.metric!, args.hidden!); break;
      case "stealth": plan = await planStealth(client, args.enabled!); break;
      case "dashboard": plan = await planDashboard(client, args.gauges, args.pinned); break;
      case "notification": plan = await planNotification(client, args.namespace!, args.enabled!); break;
      case "journal_prefs": plan = await planJournalPrefs(client, args); break;
      case "tracked_behaviors": plan = await planTracked(client, args.track ?? [], args.untrack ?? []); break;
      case "clock_format": plan = await planClock(client, args.clock_format!); break;
    }
    if ("content" in plan) return plan;

    if (plan.noChange) {
      return respond(NAME, PreferencesSetOut, {
        setting, updated: false, no_change: true, before: plan.before, after: plan.before, verified: true, warnings: plan.warnings,
      });
    }
    if (!confirm) {
      return respond(NAME, PreferencesSetOut, preview(plan.method, plan.path, {
        before: plan.before,
        after: plan.target,
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
      }));
    }

    const result = plan.method === "POST"
      ? await client.post(plan.path, plan.body)
      : plan.method === "PUT"
        ? await client.put(plan.path, plan.body)
        : await client.delete(plan.path);
    let after: unknown = null;
    try {
      after = await plan.readBack(result);
    } catch {
      plan.warnings.push("Couldn't read the setting back to verify.");
    }
    const verified = after !== null && plan.matches(after);
    if (after !== null && !verified) plan.warnings.push("WHOOP accepted the write but the setting reads back differently.");
    return respond(NAME, PreferencesSetOut, {
      setting,
      updated: true,
      no_change: false,
      before: plan.before,
      after: after === null ? null : plan.afterOut ? plan.afterOut(after) : after,
      verified,
      warnings: plan.warnings,
    });
  });

  // ─── Per-setting plans ───────────────────────────────────────────────────

  async function planHidden(c: WhoopClient, metric: string, hidden: boolean): Promise<Plan> {
    const read = async () => {
      const r = await c.get(P.hidden(metric), {}, { fresh: true });
      return isObject(r) && typeof r.is_hidden === "boolean" ? r.is_hidden : null;
    };
    const before = await read().catch(() => null);
    return {
      method: hidden ? "POST" : "DELETE",
      path: P.hidden(metric),
      body: undefined,
      before: { hidden: before },
      target: { hidden },
      noChange: before === hidden,
      readBack: async () => ({ hidden: await read() }),
      matches: (a) => eq(a, { hidden }),
      warnings: [],
    };
  }

  async function planStealth(c: WhoopClient, enabled: boolean): Promise<Plan> {
    // GET answers a bare boolean; the PUT takes {"enabled":true} or a bare false (both verified).
    const read = async () => {
      const r = await c.get(P.stealth, {}, { fresh: true });
      return typeof r === "boolean" ? r : null;
    };
    const before = await read().catch(() => null);
    return {
      method: "PUT",
      path: P.stealth,
      body: enabled ? { enabled: true } : false,
      before: { enabled: before },
      target: { enabled },
      noChange: before === enabled,
      readBack: async () => ({ enabled: await read() }),
      matches: (a) => eq(a, { enabled }),
      warnings: [],
    };
  }

  async function planDashboard(
    c: WhoopClient,
    gauges: readonly string[] | undefined,
    pinned: readonly string[] | undefined,
  ): Promise<Plan | ToolResult> {
    if (gauges && dupes(gauges).length > 0) return fail("The two gauges must differ.");
    if (pinned && dupes(pinned).length > 0) return fail(`Pinned twice: ${dupes(pinned).join(", ")}.`);
    // Omitting gauge_metrics resets the gauges to HRV + SLEEP_PERFORMANCE, so
    // both lists are always sent: whatever isn't changing comes from a fresh read.
    const raw = await c.get(P.dashboardRead, {}, { fresh: true }).catch(() => null);
    if (raw === null) {
      return fail("Couldn't read the current dashboard: WHOOP resets whatever list isn't sent, and the screen is what says which metrics your account offers. Nothing was sent; retry.");
    }
    const before = projectDashboard(raw);
    // The zod enums are WHOOP's whole KeyMetric enum (learned from a 400), which
    // includes metrics the app never offers here (CGM, PREGNANCY_WEEK, …). Only
    // send what this account's own screen offers, as the app does.
    const offered = dashboardOptions(raw);
    const notGauge = (gauges ?? []).filter((m) => !offered.gauges.includes(m));
    if (notGauge.length > 0) {
      return fail(`WHOOP doesn't offer ${notGauge.join(", ")} as a focus gauge on your account.`, { gauge_options: offered.gauges });
    }
    const notPinnable = (pinned ?? []).filter((m) => !offered.pinnable.includes(m));
    if (notPinnable.length > 0) {
      return fail(`WHOOP doesn't offer ${notPinnable.join(", ")} as a dashboard metric on your account.`, { pinned_options: offered.pinnable });
    }
    const target = { gauges: [...(gauges ?? before.gauges)], pinned: [...(pinned ?? before.pinned)] };
    if (target.gauges.length !== 2) return fail("The current dashboard doesn't have 2 focus gauges; pass gauges too.");
    return {
      method: "PUT",
      path: P.dashboardWrite,
      body: { gauge_metrics: target.gauges, pinned_metrics: target.pinned },
      before,
      target,
      noChange: eq(before, target),
      readBack: async () => projectDashboard(await c.get(P.dashboardRead, {}, { fresh: true })),
      matches: (a) => eq(a, target),
      warnings: [],
    };
  }

  async function planNotification(c: WhoopClient, namespace: string, enabled: boolean): Promise<Plan> {
    const read = async () => projectNotifications(await c.get(P.notificationsRead, {}, { fresh: true }))[namespace] ?? null;
    const before = await read().catch(() => null);
    return enabled
      ? {
          method: "DELETE",
          path: `${P.block}/${namespace}`,
          body: undefined,
          before: { [namespace]: before },
          target: { [namespace]: true },
          noChange: before === true,
          readBack: async () => ({ [namespace]: await read() }),
          matches: (a) => eq(a, { [namespace]: true }),
          warnings: [],
        }
      : {
          method: "PUT",
          path: P.block,
          body: { namespace },
          before: { [namespace]: before },
          target: { [namespace]: false },
          noChange: before === false,
          readBack: async () => ({ [namespace]: await read() }),
          matches: (a) => eq(a, { [namespace]: false }),
          warnings: [],
        };
  }

  async function planJournalPrefs(
    c: WhoopClient,
    args: { journal_enabled?: boolean | undefined; journal_autopop_enabled?: boolean | undefined; ai_autopop_enabled?: boolean | undefined },
  ): Promise<Plan | ToolResult> {
    const before = await c.get(P.journalPrefs, {}, { fresh: true }).then(projectJournalPrefs).catch(() => null);
    // The PUT merges the keys sent but 422s without journal_enabled.
    const journalEnabled = args.journal_enabled ?? before?.journal_enabled ?? null;
    if (journalEnabled === null) return fail("Couldn't read journal_enabled, which WHOOP requires on every write; pass journal_enabled or retry.");
    const body: Record<string, boolean> = { journal_enabled: journalEnabled };
    if (args.journal_autopop_enabled !== undefined) body.journal_autopop_enabled = args.journal_autopop_enabled;
    if (args.ai_autopop_enabled !== undefined) body.ai_autopop_enabled = args.ai_autopop_enabled;
    const target = { ...(before ?? {}), ...body };
    const warnings = journalEnabled === false && before?.journal_enabled !== false ? ["journal_enabled:false turns the journal off in the app."] : [];
    return {
      method: "PUT",
      path: P.journalPrefs,
      body,
      before,
      target,
      noChange: before !== null && Object.entries(body).every(([k, v]) => (before as Record<string, unknown>)[k] === v),
      readBack: async () => projectJournalPrefs(await c.get(P.journalPrefs, {}, { fresh: true })),
      matches: (a) => Object.entries(body).every(([k, v]) => isObject(a) && a[k] === v),
      warnings,
    };
  }

  async function planTracked(c: WhoopClient, track: Array<string | number>, untrack: Array<string | number>): Promise<Plan | ToolResult> {
    // The PUT replaces the whole set, so the base must be the complete tracked
    // set, read fresh. That is the customize screen's `selected` toggles:
    // /activities-service/v1/journals/behaviors/user never lists custom
    // behaviours, so a list built from it would silently untrack them.
    const readToggles = async () => projectBehaviorToggles(await c.get(P.customize, {}, { fresh: true }));
    const current = await readToggles().catch(() => null);
    if (!current || !current.complete || current.ids.length === 0) {
      return fail("Couldn't read your full tracked-behaviour list, and WHOOP replaces the whole list on write. Nothing was sent.");
    }
    const specs = new Map<number, BehaviorSpec>();
    for (const t of current.toggles) {
      // A custom toggle's internal_name is its title; stock ones carry the real internal name.
      const s = specFromTracker({
        id: t.id,
        ...(t.title ? { title: t.title } : {}),
        ...(t.custom ? { internal_name: `custom-${t.id}` } : t.internal_name ? { internal_name: t.internal_name } : {}),
        ...(t.question ? { question_text: t.question } : {}),
      }, t.selected);
      if (s) specs.set(s.id, s);
    }
    for (const b of BEHAVIORS) {
      if (!specs.has(b.behavior_tracker_id)) specs.set(b.behavior_tracker_id, specFromTracker({ id: b.behavior_tracker_id }, false)!);
    }
    const catalog: BehaviorCatalog = { specs, source: "live", warning: null };
    const problems: Array<{ error: string; suggestions: Array<{ id: number; title: string }> }> = [];
    const resolveAll = (refs: Array<string | number>) => refs.flatMap((r) => {
      const res = resolveBehavior(ref(r), catalog);
      if (res.ok) return [res.spec];
      problems.push({ error: res.error, suggestions: res.suggestions });
      return [];
    });
    const add = resolveAll(track);
    const drop = resolveAll(untrack);
    if (problems.length > 0) return fail("Some behaviours couldn't be resolved; nothing was sent.", { problems });
    const both = add.filter((a) => drop.some((d) => d.id === a.id));
    if (both.length > 0) return fail(`Can't both track and untrack: ${both.map((s) => s.title).join(", ")}.`);

    const have = new Set(current.ids);
    const dropIds = new Set(drop.map((s) => s.id));
    const next = [...current.ids.filter((id) => !dropIds.has(id)), ...add.filter((s) => !have.has(s.id)).map((s) => s.id)];
    if (next.length === 0) return fail("That would untrack every behaviour; keep at least one.");
    const added = add.filter((s) => !have.has(s.id)).map((s) => s.title);
    const removed = drop.filter((s) => have.has(s.id)).map((s) => s.title);
    const warnings: string[] = [];
    if (removed.length > 0) warnings.push("Untracking only hides a behaviour: its past answers stay and come back if you track it again.");
    if (drop.some((s) => s.custom)) warnings.push("Custom behaviours can't be deleted, only untracked.");
    const nextSet = [...next].sort((a, b) => a - b);
    return {
      method: "PUT",
      path: P.tracked,
      body: next.map(String),
      before: { count: current.ids.length },
      target: { count: next.length, added, removed },
      noChange: added.length === 0 && removed.length === 0,
      readBack: async () => {
        const after = await readToggles();
        if (!after.complete) throw new Error("tracked flags missing");
        return after.ids;
      },
      afterOut: (a) => ({ count: (a as number[]).length, added, removed }),
      matches: (a) => eq([...(a as number[])].sort((x, y) => x - y), nextSet),
      warnings,
    };
  }

  async function planClock(c: WhoopClient, clockFormat: string): Promise<Plan | ToolResult> {
    // WHOOP requires the IANA timezone with the clock format and re-cuts days
    // if it changes. There's no read for it, so only send a zone whose current
    // offset matches the profile's.
    const tz = candidateTimeZone();
    if (!tz) return fail("Totem doesn't know your IANA timezone, which WHOOP requires with the clock format. Set WHOOP_TIMEZONE (e.g. America/Los_Angeles).");
    const boot = await c.get(P.bootstrap, {}, { fresh: true });
    const profileOffset = normalizeOffset(isObject(boot) && isObject(boot.profile) ? asString(boot.profile.timezone_offset) : null);
    const tzOffset = zoneOffset(tz);
    if (!profileOffset || profileOffset !== tzOffset) {
      return fail(`Refusing: sending timezone ${tz} (${tzOffset ?? "unknown offset"}) could change your WHOOP timezone (profile offset ${profileOffset ?? "unknown"}) and re-cut your days. Set WHOOP_TIMEZONE to your WHOOP timezone.`);
    }
    const body = { clock_format: clockFormat, timezone: tz, current_time: new Date().toISOString().replace("Z", "+0000") };
    return {
      method: "POST",
      path: P.clock,
      body,
      before: null,
      // The timezone goes out with every clock-format write, so the preview shows it too.
      target: { clock_format: clockFormat, timezone: tz },
      noChange: false,
      // No user-token GET exists; the POST answers with the stored row.
      readBack: async (result) => (isObject(result) ? { clock_format: asString(result.clock_format), timezone: asString(result.timezone) } : null),
      matches: (a) => eq(a, { clock_format: clockFormat, timezone: tz }),
      warnings: ["WHOOP has no read for the clock format; verified from the write's response."],
    };
  }
}

const ref = (r: string | number) => {
  if (typeof r === "number") return { id: r };
  return /^\d+$/.test(r.trim()) ? { id: Number(r.trim()) } : { name: r };
};
