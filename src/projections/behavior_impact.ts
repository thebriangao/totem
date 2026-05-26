import type { BehaviorImpactOutT } from "../schemas/journal.js";
import { isObject, asArray, asNumber, asString } from "../lib/walk.js";
import { BEHAVIORS_BY_ID } from "../data/behaviors.js";

export function projectBehaviorImpact(raw: unknown, behaviorId: number | string): BehaviorImpactOutT {
  const root = isObject(raw) ? raw : {};
  const sections = asArray(root.sections);
  const metrics: BehaviorImpactOutT["metrics"] = [];
  for (const s of sections) {
    if (!isObject(s)) continue;
    const t = asString(s.type);
    if (t === "METRIC_CARD" || t === "IMPACT_CARD" || t === "BEHAVIOR_METRIC") {
      const name = asString(s.metric) ?? asString(s.title);
      const delta = asNumber(s.delta ?? s.delta_avg);
      const direction = (asString(s.direction) ?? "").toLowerCase();
      metrics.push({
        metric: name ?? "",
        delta_avg: delta,
        delta_unit: asString(s.unit ?? s.delta_unit),
        sample_size: asNumber(s.sample_size ?? s.n),
        direction:
          direction === "positive" || direction === "negative"
            ? (direction as "positive" | "negative")
            : "neutral",
      });
    }
  }
  const numericId = typeof behaviorId === "number" ? behaviorId : Number(behaviorId);
  const meta = !isNaN(numericId) ? BEHAVIORS_BY_ID.get(numericId) : undefined;
  return {
    behavior_id: behaviorId,
    behavior_name: meta?.title ?? null,
    metrics,
    insight: asString(root.insight ?? root.headline),
  };
}
