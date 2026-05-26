import type { LiftHistoryOutT } from "../schemas/strength.js";
import { isObject, asArray, asNumber, asString } from "../lib/walk.js";

// Whoop returns these internal_name values for set-based strength workouts.
// "weightlifting_msk" = Strength Trainer. "weightlifting" and "powerlifting"
// are manual logs. None of them contain "strength" — match by broader pattern.
function isStrengthSport(name: string | null): boolean {
  if (!name) return false;
  return /weight|strength|powerlift/i.test(name);
}

// Parse "5 Sets" → 5, "1 Set" → 1, "0 Sets" → 0. Returns null if not parseable.
function parseSetCount(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)\s*Sets?/i);
  return m && m[1] ? parseInt(m[1], 10) : null;
}

interface ProjectLiftHistoryInput {
  workouts: unknown;
  details: unknown[];
}

export function projectLiftHistory(input: ProjectLiftHistoryInput): LiftHistoryOutT {
  const root = isObject(input.workouts) ? input.workouts : {};
  const records = asArray(root.records).filter(
    (r) => isObject(r) && isStrengthSport(asString((r as Record<string, unknown>).sport_name)),
  );
  const out: LiftHistoryOutT = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as Record<string, unknown>;
    const detail = input.details[i];
    if (!isObject(detail)) continue;

    // Set-level data lives at:
    //   weightlifting_cardio_details.weightlifting_exercises.exercise_summary_carousel.items[]
    // The first item is a SUMMARY row ("8 Exercises", "29 Sets") — skip it.
    // Each subsequent item is one exercise with set_count + tonnage + total reps.
    const wld = isObject(detail.weightlifting_cardio_details)
      ? (detail.weightlifting_cardio_details as Record<string, unknown>)
      : {};
    const wex = isObject(wld.weightlifting_exercises)
      ? (wld.weightlifting_exercises as Record<string, unknown>)
      : {};
    const carousel = isObject(wex.exercise_summary_carousel)
      ? (wex.exercise_summary_carousel as Record<string, unknown>)
      : {};
    const tonnageUnits = asString(wex.tonnage_units_display);
    const items = asArray(carousel.items);

    // The first carousel item is the aggregate row ("8 Exercises", "29 Sets",
    // total tonnage in lbs). Read it before iterating real exercises.
    let summaryTonnageLbs: number | null = null;
    if (items.length > 0 && isObject(items[0])) {
      const summary = items[0] as Record<string, unknown>;
      const t = asString(summary.tonnage_display);
      if (t) {
        const n = parseFloat(t.replace(/,/g, ""));
        if (Number.isFinite(n)) summaryTonnageLbs = n;
      }
    }

    let setCount = 0;
    const exercises: LiftHistoryOutT[number]["exercises"] = [];
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (!isObject(it)) continue;
      const exId = asString(it.exercise_id);
      // Skip the aggregate summary row (no exercise_id)
      if (exId === null) continue;
      const itemSetCount = parseSetCount(asString(it.subtitle_display));
      const tonnage = (() => {
        const t = asString(it.tonnage_display);
        if (!t) return null;
        const n = parseFloat(t.replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
      })();
      const totalReps = (() => {
        const v = asString(it.volume_display);
        if (!v) return null;
        const n = parseInt(v.replace(/,/g, ""), 10);
        return Number.isFinite(n) ? n : null;
      })();
      const achievements = asArray(it.achievement_icons)
        .map((a) => asString(a))
        .filter((a): a is string => a !== null);

      exercises.push({
        exercise_id: exId,
        name: asString(it.title_display),
        set_count: itemSetCount,
        total_reps: totalReps,
        tonnage,
        tonnage_units: tonnageUnits,
        achievements,
        sets: [],  // per-set detail not in cardio-details
      });
      setCount += itemSetCount ?? 0;
    }

    const start = asString(r.start) ?? "";
    const end = asString(r.end) ?? "";
    const score = isObject(r.score) ? (r.score as Record<string, unknown>) : {};

    // MSK total volume comes from the carousel summary row (lbs). Convert to kg
    // since the schema field is _kg and the iOS app shows kg in some locales.
    const LBS_TO_KG = 0.45359237;
    const mskVolumeKg = (() => {
      if (summaryTonnageLbs === null) return null;
      if (tonnageUnits && /kg/i.test(tonnageUnits)) return summaryTonnageLbs;
      // default: assume lbs
      return Math.round(summaryTonnageLbs * LBS_TO_KG);
    })();

    // MSK intensity % from strain_breakdown.msk_percent_display ("74%")
    const strainBreakdown = isObject(detail.strain_breakdown)
      ? (detail.strain_breakdown as Record<string, unknown>)
      : {};
    const mskIntensityPct = (() => {
      const v = asString(strainBreakdown.msk_percent_display);
      if (!v) return null;
      const n = parseFloat(v.replace("%", ""));
      return Number.isFinite(n) ? n : null;
    })();

    out.push({
      activity_id: asString(r.id) ?? "",
      date: start.slice(0, 10),
      name: asString(r.name) ?? null,
      duration_ms: start && end ? new Date(end).getTime() - new Date(start).getTime() : 0,
      strain: asNumber(score.strain),
      msk_total_volume_kg: mskVolumeKg,
      msk_intensity_pct: mskIntensityPct,
      exercise_count: exercises.length,
      set_count: setCount,
      exercises,
    });
  }
  return out;
}
