// whoop_strain: GET /home-service/v1/deep-dive/strain?date= (SPEC.md §4.2).
// Its ACTIVITY items are CARDIO only: RECOVERY activities don't count toward
// strain and WHOOP leaves them out here (activities `0168be85`).
import {
  contentById, contributor, displayMinutes, displayNumber, stepperCalibration, str, type Calibration, type Node,
} from "./core_common.js";
import { activityColumns, activityRow, activityTiles, kinds, type ActivityRow } from "./core_home.js";

const MAX_STRAIN = 21;

/** Today's value vs the 30-day baseline; `trend` is WHOOP's verdict. */
export interface ContributorPair { value: number | null; baseline: number | null; trend: string | null }

export interface StrainV2 {
  date: string;
  score: number | null;
  calibrating: boolean;
  calibration: Calibration | null;
  /** Strain target and optimal band on the 0–21 scale; null while calibrating. */
  target: { value: number | null; low: number | null; high: number | null } | null;
  zones_1_3_min: ContributorPair;
  zones_4_5_min: ContributorPair;
  strength_min: ContributorPair;
  steps: ContributorPair;
  activities: { columns: ReturnType<typeof activityColumns>; rows: ActivityRow[] };
  workouts_count: number;
}

const frac = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * MAX_STRAIN * 10) / 10 : null;

function pair(m: Node | null, parse: (v: unknown) => number | null): ContributorPair {
  return {
    value: m ? parse(m.status) : null,
    baseline: m ? parse(m.status_subtitle) : null,
    trend: m && m.status_type !== "NO_DATA" ? str(m.status_type) : null,
  };
}

export function projectStrainV2(raw: unknown, date: string): StrainV2 {
  const gauge = contentById(raw, "SCORE_GAUGE", "STRAIN_SCORE_GAUGE");
  const tile = contentById(raw, "CONTRIBUTORS_TILE", "STRAIN_CONTRIBUTORS_TILE");
  const calibration = stepperCalibration(raw);
  const t = {
    value: frac(gauge?.score_target),
    low: frac(gauge?.lower_optimal_percentage),
    high: frac(gauge?.higher_optimal_percentage),
  };
  const cardio = kinds(activityTiles(raw), "CARDIO");
  return {
    date,
    score: gauge ? displayNumber(gauge.score_display) : null,
    calibrating: calibration !== null && calibration.filled < calibration.total,
    calibration,
    target: t.value === null && t.low === null && t.high === null ? null : t,
    zones_1_3_min: pair(contributor(tile, "HR_ZONES_1_3"), displayMinutes),
    zones_4_5_min: pair(contributor(tile, "HR_ZONES_4_5"), displayMinutes),
    strength_min: pair(contributor(tile, "STRENGTH_TRAINING_TIME"), displayMinutes),
    steps: pair(contributor(tile, "STEPS"), displayNumber),
    activities: { columns: activityColumns(cardio.map(activityRow)), rows: cardio.map(activityRow) },
    workouts_count: cardio.length,
  };
}
