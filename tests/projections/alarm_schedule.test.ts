import { describe, expect, it } from "vitest";
import { goalToMode, masterSwitch, projectAlarmSchedules, projectNextAlarm } from "../../src/projections/alarm_schedule.js";
import { fx } from "../tools/health_plans_helpers.js";

const row = (o: Record<string, unknown>) => ({ schedule_id: "s-1", day_of_week: "MONDAY", upper_time_bound: "07:00:00", goal: "EXACT_TIME_PERFORM", enabled: true, deleted: false, ...o });

describe("projectAlarmSchedules — sa/alarm-schedule rows are the truth", () => {
  it("groups per-day rows into short schedule rows; SLEEP_HEALTH_* → SLEEP_GOAL + sleep_goal", () => {
    expect(projectAlarmSchedules(fx("alarm_schedule_rows.json"))).toEqual({
      schedules: [
        { id: "876be9f6-c413-4ea5-9fcf-b45ffc073baa", days: ["MON", "TUE"], mode: "IN_THE_GREEN", sleep_goal: null, goal: null, wake: "07:35", enabled: true },
        { id: "9e06f7da-7261-4ba1-b0a2-ec2d41f2f14d", days: ["WED", "THU"], mode: "SLEEP_GOAL", sleep_goal: "PERFORM", goal: null, wake: "06:45", enabled: true },
      ],
      unscheduled: ["FRI", "SAT", "SUN"],
    });
  });

  it("passes unknown goals through instead of relabelling them", () => {
    const out = projectAlarmSchedules([row({ goal: "ALARM_OFF_PEAK" }), row({ day_of_week: "TUESDAY", goal: "SOMETHING_NEW" })]);
    expect(out.schedules.map((s) => [s.mode, s.goal])).toEqual([[null, "ALARM_OFF_PEAK"], [null, "SOMETHING_NEW"]]);
  });

  it("keeps rows of one schedule that disagree as separate entries, and skips deleted rows", () => {
    const out = projectAlarmSchedules([row({}), row({ day_of_week: "TUESDAY", upper_time_bound: "08:00:00" }), row({ day_of_week: "FRIDAY", deleted: true })]);
    expect(out.schedules.map((s) => [s.days, s.wake])).toEqual([[["MON"], "07:00"], [["TUE"], "08:00"]]);
    expect(out.unscheduled).toContain("FRI");
  });

  it("goal → mode", () => {
    expect(goalToMode("EXACT_TIME_PERFORM")).toEqual({ mode: "EXACT_TIME", sleep_goal: null });
    expect(goalToMode("EXACT_TIME_GET_BY")).toEqual({ mode: "EXACT_TIME", sleep_goal: null });
    expect(goalToMode("SLEEP_HEALTH_GET_BY")).toEqual({ mode: "SLEEP_GOAL", sleep_goal: "GET_BY" });
    expect(goalToMode("IN_THE_GREEN")).toEqual({ mode: "IN_THE_GREEN", sleep_goal: null });
    expect(goalToMode("ALARM_OFF_PERFORM")).toEqual({ mode: null, sleep_goal: null });
  });
});

describe("next alarm and master switch", () => {
  it("next alarm window from alarm_bounds (hour-only offsets)", () => {
    expect(projectNextAlarm(fx("alarm_preferences.json"))).toEqual({ date: "2026-11-22", from: "07:10", to: "08:10", goal: "SLEEP_HEALTH_GET_BY", enabled: true });
  });
  it("master switch from schedule/all, else preferences, else unavailable", () => {
    expect(masterSwitch(fx("alarm_schedule_all.json"), null)).toBe(true);
    expect(masterSwitch(null, { schedule_enabled: false })).toBe(false);
    expect(masterSwitch(null, null)).toBe("unavailable");
  });
});
