import type { ProfileOutT } from "../schemas/profile.js";
import { BootstrapSchema } from "../whoop/types.js";
import { kgToLb, metersToCm, metersToFeet } from "../lib/format.js";
import { isObject, asBool } from "../lib/walk.js";

interface ProjectProfileInput {
  bootstrap: unknown;
  hidden_body_comp: unknown;
  hidden_healthspan: unknown;
  stealth: unknown;
}

export function projectProfile(input: ProjectProfileInput): ProfileOutT {
  const parsed = BootstrapSchema.parse(input.bootstrap);

  const bodyHidden = isObject(input.hidden_body_comp)
    ? asBool((input.hidden_body_comp as Record<string, unknown>).is_hidden) ?? false
    : false;
  const healthspanHidden = isObject(input.hidden_healthspan)
    ? asBool((input.hidden_healthspan as Record<string, unknown>).is_hidden) ?? false
    : false;
  const stealthMode = isObject(input.stealth)
    ? asBool((input.stealth as Record<string, unknown>).enabled) ?? false
    : false;

  const heightM = parsed.profile?.height ?? null;
  const weightKg = parsed.profile?.weight ?? null;

  // Whoop returns birthday as ISO datetime ("1990-01-01T00:00:00.000Z").
  // Schema wants YYYY-MM-DD. Trim.
  const birthdayRaw = parsed.profile?.birthday ?? null;
  const birthday = birthdayRaw ? birthdayRaw.slice(0, 10) : null;

  return {
    user_id: parsed.user.id,
    account_id: parsed.account.id,
    email: parsed.account.email,
    username: parsed.account.username,
    first_name: parsed.user.first_name,
    last_name: parsed.user.last_name,
    birthday,
    gender: parsed.profile?.gender ?? null,
    height: {
      m: heightM,
      cm: heightM !== null ? metersToCm(heightM) : null,
      ft: heightM !== null ? metersToFeet(heightM) : null,
    },
    weight: {
      kg: weightKg,
      lb: weightKg !== null ? kgToLb(weightKg) : null,
    },
    city: parsed.user.city ?? null,
    country: parsed.user.country ?? null,
    timezone_offset: parsed.profile?.timezone_offset ?? "+0000",
    bio_data: {
      max_hr_bpm: parsed.bio_data?.max_heart_rate ?? 0,
      resting_hr_bpm: parsed.bio_data?.resting_heart_rate ?? 0,
      min_hr_bpm: parsed.bio_data?.min_heart_rate ?? null,
    },
    fitness_level: parsed.profile?.fitness_level ?? null,
    membership: {
      status: parsed.membership.status,
      in_effect: parsed.membership.in_effect,
    },
    privacy: {
      stealth_mode: stealthMode,
      body_comp_hidden: bodyHidden,
      healthspan_hidden: healthspanHidden,
    },
  };
}
