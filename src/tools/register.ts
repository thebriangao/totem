import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../whoop/client.js";

// Snapshots
import { registerToday } from "./v2/today.js";
import { registerDay } from "./v2/day.js";
import { registerProfile } from "./v2/profile.js";
import { registerCalendar } from "./v2/calendar.js";
// Deep dives
import { registerRecovery } from "./v2/recovery.js";
import { registerSleep } from "./v2/sleep.js";
import { registerStrain } from "./v2/strain.js";
// Trends + compare
import { registerTrend } from "./v2/trend.js";
import { registerCompare } from "./v2/compare.js";
// Stress + sleep_need
import { registerStress } from "./v2/stress.js";
import { registerSleepNeed } from "./v2/sleep_need.js";
// Live
import { registerLiveHr } from "./v2/live_hr.js";
import { registerLiveState } from "./v2/live_state.js";
import { registerLiveStress } from "./v2/live_stress.js";
// Activities
import { registerWorkouts } from "./v2/workouts.js";
import { registerWorkout } from "./v2/workout.js";
import { registerActivityCreate } from "./v2/activity_create.js";
import { registerActivityDelete } from "./v2/activity_delete.js";
import { registerSportsCatalog } from "./v2/sports_catalog.js";
// Strength reads
import { registerLiftPrs } from "./v2/lift_prs.js";
import { registerLiftExercise } from "./v2/lift_exercise.js";
import { registerLiftProgression } from "./v2/lift_progression.js";
import { registerLiftHistory } from "./v2/lift_history.js";
import { registerLiftLibrary } from "./v2/lift_library.js";
import { registerLiftCatalog } from "./v2/lift_catalog.js";
// Strength writes
import { registerLiftLog } from "./v2/lift_log.js";
import { registerLiftTemplateSave } from "./v2/lift_template_save.js";
import { registerLiftCustomExercise } from "./v2/lift_custom_exercise.js";
// Journal
import { registerJournal } from "./v2/journal.js";
import { registerJournalCatalog } from "./v2/journal_catalog.js";
import { registerBehaviorImpact } from "./v2/behavior_impact.js";
import { registerJournalLog } from "./v2/journal_log.js";
import { registerJournalAutopop } from "./v2/journal_autopop.js";
// Women's health
import { registerCycle } from "./v2/cycle.js";
import { registerCycleLog } from "./v2/cycle_log.js";
import { registerSymptomLog } from "./v2/symptom_log.js";
// Coach + performance
import { registerCoachAsk } from "./v2/coach_ask.js";
import { registerPerformanceAssessment } from "./v2/performance_assessment.js";
// Smart alarm
import { registerSmartAlarm } from "./v2/smart_alarm.js";
import { registerSmartAlarmSet } from "./v2/smart_alarm_set.js";
// Social
import { registerLeaderboard } from "./v2/leaderboard.js";
// Settings
import { registerHrZones } from "./v2/hr_zones.js";
import { registerHrZonesSet } from "./v2/hr_zones_set.js";
import { registerProfileUpdate } from "./v2/profile_update.js";
import { registerHiddenMetric } from "./v2/hidden_metric.js";
// Escape
import { registerRaw } from "./v2/raw.js";
import { registerEndpoints } from "./v2/endpoints.js";

export function registerTools(server: McpServer, client: WhoopClient): void {
  // Reads (31)
  registerToday(server, client);
  registerDay(server, client);
  registerProfile(server, client);
  registerCalendar(server, client);
  registerRecovery(server, client);
  registerSleep(server, client);
  registerStrain(server, client);
  registerTrend(server, client);
  registerCompare(server, client);
  registerStress(server, client);
  registerSleepNeed(server, client);
  registerLiveHr(server, client);
  registerLiveState(server, client);
  registerLiveStress(server, client);
  registerWorkouts(server, client);
  registerWorkout(server, client);
  registerSportsCatalog(server, client);
  registerLiftPrs(server, client);
  registerLiftExercise(server, client);
  registerLiftProgression(server, client);
  registerLiftHistory(server, client);
  registerLiftLibrary(server, client);
  registerLiftCatalog(server, client);
  registerJournal(server, client);
  registerJournalCatalog(server, client);
  registerBehaviorImpact(server, client);
  registerCycle(server, client);
  registerPerformanceAssessment(server, client);
  registerSmartAlarm(server, client);
  registerLeaderboard(server, client);
  registerHrZones(server, client);
  // Writes (14: 13 + coach_ask)
  registerActivityCreate(server, client);
  registerActivityDelete(server, client);
  registerLiftLog(server, client);
  registerLiftTemplateSave(server, client);
  registerLiftCustomExercise(server, client);
  registerJournalLog(server, client);
  registerJournalAutopop(server, client);
  registerCycleLog(server, client);
  registerSymptomLog(server, client);
  registerSmartAlarmSet(server, client);
  registerHrZonesSet(server, client);
  registerProfileUpdate(server, client);
  registerHiddenMetric(server, client);
  registerCoachAsk(server, client);
  // Escape (2)
  registerRaw(server, client);
  registerEndpoints(server, client);
}
