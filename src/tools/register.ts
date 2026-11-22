// The v2 tool surface: 40 tools (23 read, 17 write) and 5 catalog resources.
// Reads are consolidated (one tool per question a person asks); writes stay
// split by risk so each tool's MCP annotation means something.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../whoop/client.js";

// Daily picture
import { registerDay } from "./v2/day.js";
import { registerRecovery } from "./v2/recovery.js";
import { registerSleep } from "./v2/sleep.js";
import { registerStrain } from "./v2/strain.js";
import { registerStress } from "./v2/stress.js";
import { registerNow } from "./v2/now.js";
import { registerTrend } from "./v2/trend.js";
import { registerCalendar } from "./v2/calendar.js";
// Activities
import { registerWorkouts } from "./v2/workouts.js";
import { registerActivityLog } from "./v2/activity_log.js";
import { registerActivityEdit } from "./v2/activity_edit.js";
import { registerActivityDelete } from "./v2/activity_delete.js";
// Strength
import { registerLiftSessions } from "./v2/lift_sessions.js";
import { registerLiftExercise } from "./v2/lift_exercise.js";
import { registerLiftLibrary } from "./v2/lift_library.js";
import { registerLiftLog } from "./v2/lift_log.js";
import { registerLiftTemplate } from "./v2/lift_template.js";
import { registerLiftExerciseSet } from "./v2/lift_exercise_set.js";
// Journal
import { registerJournal } from "./v2/journal.js";
import { registerJournalLog } from "./v2/journal_log.js";
// Coach and memory
import { registerCoachAsk } from "./v2/coach_ask.js";
import { registerCoachHistory } from "./v2/coach_history.js";
import { registerMemory } from "./v2/memory.js";
import { registerMemorySet } from "./v2/memory_set.js";
// Body, cycle, plans
import { registerWeight } from "./v2/weight.js";
import { registerWeightLog } from "./v2/weight_log.js";
import { registerCycle } from "./v2/cycle.js";
import { registerCycleLog } from "./v2/cycle_log.js";
import { registerWeeklyPlan } from "./v2/weekly_plan.js";
import { registerWeeklyPlanSet } from "./v2/weekly_plan_set.js";
import { registerMilestones } from "./v2/milestones.js";
// Settings
import { registerSmartAlarm } from "./v2/smart_alarm.js";
import { registerSmartAlarmSet } from "./v2/smart_alarm_set.js";
import { registerProfile } from "./v2/profile.js";
import { registerProfileUpdate } from "./v2/profile_update.js";
import { registerHrZonesSet } from "./v2/hr_zones_set.js";
import { registerPreferences } from "./v2/preferences.js";
import { registerPreferencesSet } from "./v2/preferences_set.js";
// Community
import { registerCommunity } from "./v2/community.js";
// Escape hatch
import { registerRaw } from "./v2/raw.js";
import { registerResources } from "./resources.js";
import { installSlimToolList } from "./slim_schema.js";

type Register = (server: McpServer, client: WhoopClient) => void;

/** Read-only tools (23). */
export const READ_TOOLS: readonly Register[] = [
  registerDay, registerRecovery, registerSleep, registerStrain, registerStress, registerNow, registerTrend, registerCalendar,
  registerWorkouts,
  registerLiftSessions, registerLiftExercise, registerLiftLibrary,
  registerJournal,
  registerCoachHistory, registerMemory,
  registerWeight, registerCycle, registerWeeklyPlan, registerMilestones,
  registerSmartAlarm, registerProfile, registerPreferences,
  registerCommunity,
];

/** Write tools (17), whoop_raw included. Each previews unless confirm:true. */
export const WRITE_TOOLS: readonly Register[] = [
  registerActivityLog, registerActivityEdit, registerActivityDelete,
  registerLiftLog, registerLiftTemplate, registerLiftExerciseSet,
  registerJournalLog,
  registerCoachAsk, registerMemorySet,
  registerWeightLog, registerCycleLog, registerWeeklyPlanSet,
  registerSmartAlarmSet, registerProfileUpdate, registerHrZonesSet, registerPreferencesSet,
  registerRaw,
];

export function registerTools(server: McpServer, client: WhoopClient): void {
  for (const register of READ_TOOLS) register(server, client);
  for (const register of WRITE_TOOLS) register(server, client);
  registerResources(server);
  installSlimToolList(server);
}
