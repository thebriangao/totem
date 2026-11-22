import type { z } from "zod";

/** Extract only conventional API validation fields; never echo an arbitrary body. */
export function apiErrorDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["error_description", "error", "message", "detail"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 300);
    }
  } catch {
    // Not JSON. WHOOP answers some validation failures as short text/plain
    // ("Requested impact not found."); expose those, but never an HTML page or a
    // long body (it could carry a fragment of health data).
    const text = body.trim();
    if (text && text.length <= 300 && !text.startsWith("<")) return text.replace(/\s+/g, " ");
    const title = htmlTitle(body);
    if (title) return title;
  }
  return undefined;
}

/** `<title>` of an HTML error page (Cloudflare/Jetty), if any. */
export function htmlTitle(body: string): string | undefined {
  const m = body.match(/<title>([^<]{1,200})<\/title>/i);
  return m ? m[1]!.trim() : undefined;
}

export interface OverlappingActivity {
  id?: string | undefined;
  type?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  /** Human-readable form, e.g. "Rowing 7:45 AM – 7:55 AM" (the member's local clock). */
  label?: string | undefined;
}

/**
 * Parse the 409 overlap body from create/edit-activity writes. WHOOP's app-facing
 * endpoints list overlaps as display strings ("**Rowing** - 7:45 AM - 7:55 AM",
 * the member's local clock, no ids); object entries are accepted too. Text-only
 * 409s (cardio-details edit, lift log) list nothing.
 */
export function parseOverlaps(body: string): OverlappingActivity[] {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const list = (parsed.overlapping_activities ?? (parsed.error as Record<string, unknown> | undefined)?.overlapping_activities) as unknown;
    if (!Array.isArray(list)) return [];
    return list.map((raw): OverlappingActivity => {
      if (typeof raw === "string") {
        const text = raw.replace(/\*\*/g, "").trim();
        const m = text.match(/^(.*?)\s+-\s+(.+?)\s+-\s+(.+)$/);
        return m ? { type: m[1]!.trim(), start: m[2]!.trim(), end: m[3]!.trim(), label: `${m[1]!.trim()} ${m[2]!.trim()} – ${m[3]!.trim()}` } : { label: text };
      }
      const a = (raw ?? {}) as Record<string, unknown>;
      const during = typeof a.during === "string" ? a.during.match(/'([^']+)','([^']*)'/) : null;
      const o: OverlappingActivity = {
        id: (a.activity_id ?? a.id ?? a.activity_v2_id) as string | undefined,
        type: (a.activity_internal_name ?? a.internal_name ?? a.type ?? a.activity_type) as string | undefined,
        start: (a.start_time ?? a.start ?? during?.[1]) as string | undefined,
        end: (a.end_time ?? a.end ?? during?.[2]) as string | undefined,
      };
      o.label = [o.type, o.id, o.start && o.end ? `${o.start} – ${o.end}` : o.start].filter(Boolean).join(" ") || undefined;
      return o;
    });
  } catch {
    return [];
  }
}

export class WhoopAuthExpiredError extends Error {
  constructor(detail?: string) {
    super(
      `Whoop login expired${detail ? ` (${detail})` : ""}. Run \`totem auth\` to log in again.`,
    );
    this.name = "WhoopAuthExpiredError";
  }
}

export class WhoopApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
    description?: string,
  ) {
    // Keep the raw body on `.body` for debugging, but keep it OUT of the
    // human/AI-facing message: a 4xx body can carry a fragment of health data,
    // and this message surfaces to the model and stderr.
    super(`Whoop API error ${status} on ${path}${description ? `: ${description}` : ""}`);
    this.name = "WhoopApiError";
  }
}

export class WhoopServerError extends Error {
  constructor(public readonly status: number, public readonly path: string, detail?: string) {
    super(
      `Whoop API returned ${status} on ${path}${detail ? ` (${detail})` : ""}. This is usually transient — try again in 30s. ` +
        `A 500 right after a write can also mean WHOOP rejected the values (it validates some fields only after saving).`,
    );
    this.name = "WhoopServerError";
  }
}

/** 401 that survived a fresh token: WHOOP refuses this endpoint for user tokens. */
export class WhoopEndpointUnauthorizedError extends Error {
  constructor(public readonly path: string) {
    super(`WHOOP rejected ${path} for user tokens (401 with a freshly refreshed token). This endpoint isn't available to this account; it is not an expired login.`);
    this.name = "WhoopEndpointUnauthorizedError";
  }
}

/** 409 on a write: overlap with existing activities, or a conflicting state. */
export class WhoopConflictError extends WhoopApiError {
  constructor(path: string, body: string, public readonly overlaps: OverlappingActivity[], description?: string) {
    super(409, path, body, description ?? (overlaps.length ? `overlaps ${overlaps.length} existing activit${overlaps.length === 1 ? "y" : "ies"}` : undefined));
    this.name = "WhoopConflictError";
  }
}

export class WhoopProjectionError extends Error {
  constructor(public readonly tool: string, public readonly issue: z.ZodError) {
    super(`Projection for ${tool} failed zod parse: ${issue.message.slice(0, 200)}`);
    this.name = "WhoopProjectionError";
  }
}
