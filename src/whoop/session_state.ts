// Per-session "catalog consulted" gate.
//
// MCP servers run as a persistent process per client. Tools that take large-
// enum-style IDs (sport_id, exercise_id, behavior_tracker_id) refuse to run
// until the AI has called the corresponding lookup tool at least once in the
// session. This lets us keep example IDs out of every tool's description (saves
// ~3-5k system-prompt tokens per session) while still enforcing that the AI
// has actually seen the real catalog before guessing.
//
// Catalog → unlock tool → gated tools:
//   sports    ← whoop_sports_catalog  → whoop_activity_create
//   exercises ← whoop_lift_catalog    → whoop_lift_log, whoop_lift_exercise,
//                                       whoop_lift_progression, whoop_lift_template_save,
//                                       whoop_lift_custom_exercise
//   behaviors ← whoop_journal_catalog → whoop_journal_log, whoop_symptom_log

export type CatalogName = "sports" | "exercises" | "behaviors";

const consulted = new Set<CatalogName>();

export function markConsulted(c: CatalogName): void {
  consulted.add(c);
}

export function gateError(
  catalog: CatalogName,
  lookupTool: string,
): { error: string; hint: string } | null {
  if (consulted.has(catalog)) return null;
  return {
    error: `Must call ${lookupTool} first to view the ${catalog} catalog. This MCP enforces lookup-first to keep tool descriptions small (your system prompt does not contain the full ${catalog} list).`,
    hint: `Call ${lookupTool} once (e.g. with no args or with search='...') to unlock every tool that takes ${catalog} IDs for the rest of this session.`,
  };
}

// Test-only — reset state between matrix runs etc.
export function _resetConsulted(): void {
  consulted.clear();
}
