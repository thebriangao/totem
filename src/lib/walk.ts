// Tree-walking + type-coercion helpers used across projections.
// Defensive: every helper short-circuits on bad shapes instead of throwing.

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

export function asString(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

export function asNumber(x: unknown): number | null {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const cleaned = x.replace(/,/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asBool(x: unknown): boolean | null {
  if (typeof x === "boolean") return x;
  if (x === "true") return true;
  if (x === "false") return false;
  return null;
}

export function asMedal(x: unknown): "GOLD" | "SILVER" | "BRONZE" | null {
  if (x === "BADGE_GOLD") return "GOLD";
  if (x === "BADGE_SILVER") return "SILVER";
  if (x === "BADGE_BRONZE") return "BRONZE";
  return null;
}

export function findFirst(
  node: unknown,
  predicate: (n: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (isObject(node)) {
    if (predicate(node)) return node;
    for (const v of Object.values(node)) {
      const found = findFirst(v, predicate);
      if (found) return found;
    }
  } else if (Array.isArray(node)) {
    for (const v of node) {
      const found = findFirst(v, predicate);
      if (found) return found;
    }
  }
  return null;
}

export function findAll(
  node: unknown,
  predicate: (n: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (isObject(node)) {
    if (predicate(node)) out.push(node);
    for (const v of Object.values(node)) out.push(...findAll(v, predicate));
  } else if (Array.isArray(node)) {
    for (const v of node) out.push(...findAll(v, predicate));
  }
  return out;
}

export function findByType(node: unknown, type: string): Record<string, unknown> | null {
  return findFirst(node, (n) => n.type === type);
}

export function findAllByType(node: unknown, type: string): Record<string, unknown>[] {
  return findAll(node, (n) => n.type === type);
}

/**
 * Find a GRAPHING_CARD whose content.title contains the given substring (case-insensitive).
 * Used by recovery / strain / trend projections that identify cards by display title.
 */
export function findCardByTitle(node: unknown, titleSubstr: string): Record<string, unknown> | null {
  const upper = titleSubstr.toUpperCase();
  return findFirst(node, (n) => {
    if (n.type !== "GRAPHING_CARD") return false;
    const content = isObject(n.content) ? (n.content as Record<string, unknown>) : null;
    const title = content && typeof content.title === "string" ? content.title : "";
    return title.toUpperCase().includes(upper);
  });
}

/**
 * Find a DETAILS_GRAPHING_CARD whose content.card_title contains the substring.
 */
export function findDetailsCardByTitle(node: unknown, titleSubstr: string): Record<string, unknown> | null {
  const upper = titleSubstr.toUpperCase();
  return findFirst(node, (n) => {
    if (n.type !== "DETAILS_GRAPHING_CARD") return false;
    const content = isObject(n.content) ? (n.content as Record<string, unknown>) : null;
    const title = content && typeof content.card_title === "string" ? content.card_title : "";
    return title.toUpperCase().includes(upper);
  });
}

/**
 * Extract today's value from a GRAPHING_CARD. Handles two plot shapes:
 *   - segments[].points[last].graph_label.label  (line plots)
 *   - bar_groups[last].top_label.label           (bar plots)
 * Returns the label as a string (often has units like "78%" or "1:41" or "4,880").
 */
export function latestGraphLabel(card: Record<string, unknown> | null): string | null {
  if (!card) return null;
  const content = isObject(card.content) ? (card.content as Record<string, unknown>) : {};
  const graph = isObject(content.graph) ? (content.graph as Record<string, unknown>) : {};
  const plots = asArray(graph.plots);
  for (const p of plots) {
    if (!isObject(p)) continue;
    const plot = isObject(p.plot) ? (p.plot as Record<string, unknown>) : null;
    if (!plot) continue;
    // Bar plot
    const bars = asArray(plot.bar_groups);
    if (bars.length > 0) {
      const last = bars[bars.length - 1];
      if (isObject(last)) {
        const topLabel = isObject(last.top_label) ? (last.top_label as Record<string, unknown>) : null;
        const label = topLabel && asString(topLabel.label);
        if (label) return label;
      }
    }
    // Line plot
    const segments = asArray(plot.segments);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!isObject(seg)) continue;
      const points = asArray(seg.points);
      for (let j = points.length - 1; j >= 0; j--) {
        const pt = points[j];
        if (!isObject(pt)) continue;
        const graphLabel = isObject(pt.graph_label) ? (pt.graph_label as Record<string, unknown>) : null;
        const label = graphLabel && asString(graphLabel.label);
        if (label) return label;
      }
    }
  }
  return null;
}

/**
 * Extract numeric value from a label like "78%", "42", "14.7", "1,792".
 * Strips trailing % and commas. Returns null for time labels like "1:41".
 */
export function labelToNumber(label: string | null): number | null {
  if (label === null) return null;
  // Time format like "7:24" or "1:41" — not a number
  if (/^\d+:\d+$/.test(label)) return null;
  const cleaned = label.replace(/,/g, "").replace(/%$/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert "H:MM" or "HH:MM" to milliseconds.
 */
export function timeLabelToMs(label: string | null): number | null {
  if (label === null) return null;
  const m = label.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 3600 + minutes * 60) * 1000;
}

/**
 * Collect all data points from a GRAPHING_CARD as {date, value} pairs.
 * Uses graph_label.label as the value source (fallback to data_scrubber_details.value_display).
 */
export interface CardPoint {
  date: string | null;
  value: number | null;
  label: string | null;
}
export function cardPoints(card: Record<string, unknown> | null): CardPoint[] {
  if (!card) return [];
  const content = isObject(card.content) ? (card.content as Record<string, unknown>) : {};
  const graph = isObject(content.graph) ? (content.graph as Record<string, unknown>) : {};
  const out: CardPoint[] = [];
  for (const p of asArray(graph.plots)) {
    if (!isObject(p)) continue;
    const plot = isObject(p.plot) ? (p.plot as Record<string, unknown>) : null;
    if (!plot) continue;
    for (const seg of asArray(plot.segments)) {
      if (!isObject(seg)) continue;
      for (const pt of asArray(seg.points)) {
        if (!isObject(pt)) continue;
        const label = isObject(pt.graph_label) ? asString((pt.graph_label as Record<string, unknown>).label) : null;
        const dsd = isObject(pt.data_scrubber_details) ? (pt.data_scrubber_details as Record<string, unknown>) : {};
        out.push({
          date: asString(dsd.primary_contextual_display),
          value: labelToNumber(label) ?? asNumber(dsd.value),
          label,
        });
      }
    }
    for (const group of asArray(plot.bar_groups)) {
      if (!isObject(group)) continue;
      const topLabel = isObject(group.top_label) ? asString((group.top_label as Record<string, unknown>).label) : null;
      const dsd = isObject(group.data_scrubber_details) ? (group.data_scrubber_details as Record<string, unknown>) : {};
      out.push({
        date: asString(dsd.primary_contextual_display),
        value: labelToNumber(topLabel),
        label: topLabel,
      });
    }
  }
  return out;
}

// ─── LiftSession + PR + graph extraction (relocated from v1's whoop/parsers.ts) ───

export interface LiftSet {
  reps: number;
  weight: number | null;
  units: string | null;
  time_seconds: number | null;
  medal: "GOLD" | "SILVER" | "BRONZE" | null;
}

export interface LiftSession {
  date: string;
  top_set: { reps: number; weight: number | null; units: string | null; medal: "GOLD" | "SILVER" | "BRONZE" | null };
  sets: LiftSet[];
  total_volume: number | null;
  total_volume_units: string | null;
  activity_id: string | null;
}

export interface GraphPoint {
  primary_label: string | null;
  secondary_label: string | null;
  value: number | null;
  value_display: string | null;
  unit: string | null;
}

export interface PrTile {
  exercise_id: string;
  name: string;
  muscle_groups: string[];
  equipment: string;
  pr_value: number | null;
  pr_units: string | null;
  image_url: string | null;
  custom_exercise: boolean;
}

function extractSet(row: unknown): LiftSet | null {
  if (!isObject(row)) return null;
  const items = asArray(row.items);
  if (items.length < 2) return null;
  const repsCell = items[0];
  const weightCell = items[1];
  if (!isObject(repsCell) || !isObject(weightCell)) return null;
  const reps = asNumber(repsCell.value);
  if (reps === null) return null;
  const weightOrTimeUnits = asString(weightCell.units);
  const weightOrTimeValue = asNumber(weightCell.value);
  const isTime = weightOrTimeUnits === "sec" || weightOrTimeUnits === "s";
  return {
    reps,
    weight: isTime ? null : weightOrTimeValue,
    units: isTime ? null : weightOrTimeUnits,
    time_seconds: isTime ? (weightOrTimeValue !== null ? Math.round(weightOrTimeValue) : null) : null,
    medal: asMedal(weightCell.achievement_icon),
  };
}

function extractBreakdownSets(node: unknown): LiftSet[] {
  if (!isObject(node)) return [];
  if (node.type !== "EXERCISE_BREAKDOWN") return [];
  const content = isObject(node.content) ? node.content : {};
  return asArray(content.rows)
    .map(extractSet)
    .filter((s): s is LiftSet => s !== null);
}

export function extractSession(card: unknown): LiftSession | null {
  if (!isObject(card)) return null;
  const content = isObject(card.content) ? card.content : {};
  let headerContent: Record<string, unknown> | null = null;
  if (isObject(content.header_content)) {
    const hc = content.header_content as Record<string, unknown>;
    headerContent = isObject(hc.content) ? (hc.content as Record<string, unknown>) : hc;
  }
  if (!headerContent) return null;

  const recordDate = asString(headerContent.record_date) ?? "";
  const subtitle = isObject(headerContent.record_subtitle) ? headerContent.record_subtitle : {};
  const title = isObject(headerContent.record_title) ? headerContent.record_title : {};
  const medal = asMedal(headerContent.achievement_icon);
  const reps = asNumber(subtitle.value) ?? 0;
  const weight = asNumber(title.value);
  const units = asString(title.unit);

  const blocks = asArray(content.expanded_content);
  const breakdowns = blocks.filter((b) => isObject(b) && b.type === "EXERCISE_BREAKDOWN");
  const sets = breakdowns.length > 0 ? extractBreakdownSets(breakdowns[0]) : [];
  let totalVolume: number | null = null;
  let totalVolumeUnits: string | null = null;
  if (breakdowns.length >= 2) {
    const second = breakdowns[1] as Record<string, unknown>;
    const secondContent = isObject(second.content) ? (second.content as Record<string, unknown>) : {};
    const rows = asArray(secondContent.rows);
    const totalRow = rows[0];
    if (isObject(totalRow)) {
      const items = asArray(totalRow.items);
      if (items.length >= 2 && isObject(items[1])) {
        totalVolume = asNumber((items[1] as Record<string, unknown>).value);
        totalVolumeUnits = asString((items[1] as Record<string, unknown>).units);
      }
    }
  }

  let activityId: string | null = null;
  for (const b of blocks) {
    if (!isObject(b) || b.type !== "CARD_BUTTON") continue;
    const bContent = isObject(b.content) ? (b.content as Record<string, unknown>) : {};
    const dest = isObject(bContent.destination) ? (bContent.destination as Record<string, unknown>) : null;
    const params = dest && isObject(dest.parameters) ? (dest.parameters as Record<string, unknown>) : null;
    if (params && typeof params.activity_id === "string") {
      activityId = params.activity_id;
      break;
    }
  }

  return {
    date: recordDate,
    top_set: { reps, weight, units, medal },
    sets,
    total_volume: totalVolume,
    total_volume_units: totalVolumeUnits,
    activity_id: activityId,
  };
}

export function extractSessions(response: unknown): LiftSession[] {
  if (!isObject(response)) return [];
  return asArray(response.items)
    .map(extractSession)
    .filter((s): s is LiftSession => s !== null);
}

export function extractPrTiles(response: unknown): PrTile[] {
  if (!isObject(response)) return [];
  return asArray(response.tiles)
    .map((t) => {
      if (!isObject(t)) return null;
      const exerciseId = asString(t.exercise_id);
      const name = asString(t.name);
      if (!exerciseId || !name) return null;
      return {
        exercise_id: exerciseId,
        name,
        muscle_groups: asArray(t.muscle_groups).filter((x): x is string => typeof x === "string"),
        equipment: asString(t.equipment) ?? "",
        pr_value: asNumber(t.volume_input_value),
        pr_units: asString(t.volume_input_units),
        image_url: asString(t.image_url),
        custom_exercise: t.custom_exercise === true,
      };
    })
    .filter((t): t is PrTile => t !== null);
}

export function extractGraphPoints(node: unknown): GraphPoint[] {
  if (!isObject(node)) return [];
  let graph: Record<string, unknown> = node;
  if (isObject(node.graph)) graph = node.graph as Record<string, unknown>;
  const plots = asArray(graph.plots);
  const points: GraphPoint[] = [];
  for (const p of plots) {
    if (!isObject(p)) continue;
    const plot = isObject(p.plot) ? (p.plot as Record<string, unknown>) : null;
    if (!plot) continue;
    for (const seg of asArray(plot.segments)) {
      if (!isObject(seg)) continue;
      for (const pt of asArray(seg.points)) {
        if (!isObject(pt)) continue;
        const dsd = isObject(pt.data_scrubber_details) ? (pt.data_scrubber_details as Record<string, unknown>) : {};
        points.push({
          primary_label: asString(dsd.primary_contextual_display),
          secondary_label: asString(dsd.secondary_contextual_display),
          value: asNumber(dsd.value),
          value_display: asString(dsd.value_display),
          unit: asString(dsd.unit_display),
        });
      }
    }
    for (const group of asArray(plot.bar_groups)) {
      if (!isObject(group)) continue;
      for (const bar of asArray(group.bars)) {
        if (!isObject(bar)) continue;
        const dsd = isObject(bar.data_scrubber_details) ? (bar.data_scrubber_details as Record<string, unknown>) : {};
        points.push({
          primary_label: asString(dsd.primary_contextual_display),
          secondary_label: asString(dsd.secondary_contextual_display),
          value: asNumber(dsd.value),
          value_display: asString(dsd.value_display),
          unit: asString(dsd.unit_display),
        });
      }
    }
  }
  return points;
}
