// Weight units for writes (SPEC.md D2). Lift, link, template and 1RM writes are
// read by WHOOP in the account's CURRENT display unit and stored as kg; weight
// readings and the profile are always kg. So every lift-side write reads the
// unit fresh (the user may switch it in the app at any time) and converts.
import type { WhoopClient } from "./client.js";

export type WeightUnit = "kg" | "lb";
export const KG_PER_LB = 0.45359237;

export function toKg(value: number, unit: WeightUnit): number {
  return unit === "kg" ? value : value * KG_PER_LB;
}
export function fromKg(kg: number, unit: WeightUnit): number {
  return unit === "kg" ? kg : kg / KG_PER_LB;
}
/** Convert between units, rounding to 2 decimals (WHOOP displays 1 decimal). */
export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value;
  return Math.round(fromKg(toKg(value, from), to) * 100) / 100;
}

/**
 * The account's display weight unit, read fresh from bootstrap. `metric` → kg,
 * `imperial` → lb. Other values (WHOOP also returns `stone` for some accounts)
 * have no verified lift-weight unit, so writes refuse rather than guess.
 */
export async function accountWeightUnit(client: WhoopClient): Promise<WeightUnit> {
  const boot = await client.get<{ profile?: { unit_system?: string } }>("/users-service/v2/bootstrap", {}, { fresh: true });
  const system = boot?.profile?.unit_system;
  if (system === "metric") return "kg";
  if (system === "imperial") return "lb";
  throw new Error(
    `This account's unit system is "${system ?? "unknown"}". Totem only knows how WHOOP reads lift weights for metric (kg) and imperial (lb) accounts; switch units in the WHOOP app or log this in the app.`,
  );
}
