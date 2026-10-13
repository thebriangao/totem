const KJ_PER_CALORIE = 4.184;
const M_PER_FT = 0.3048;
const LB_PER_KG = 2.20462;

export function kjToCal(kj: number): number {
  return Math.round(kj / KJ_PER_CALORIE);
}

export function metersToFeet(m: number): number {
  return Math.round((m / M_PER_FT) * 10) / 10;
}

export function metersToCm(m: number): number {
  return Math.round(m * 100);
}

export function kgToLb(kg: number): number {
  return Math.round(kg * LB_PER_KG * 10) / 10;
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

export function secondsToMinutes(s: number): number {
  return Math.round(s / 60);
}

export function round(n: number, digits: number): number {
  return Number(n.toFixed(digits));
}

/** Body fat as WHOOP stores it (fraction, 0.185) → percentage (18.5). */
export function fatFractionToPercent(fraction: number): number {
  return round(fraction * 100, 1);
}

/** Body fat percentage (18.5) → the fraction WHOOP stores (0.185). */
export function fatPercentToFraction(percent: number): number {
  return round(percent / 100, 4);
}
