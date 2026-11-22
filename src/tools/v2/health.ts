// whoop_health (R, EXPERIMENTAL): Healthspan, blood pressure insights, AFib
// history, Advanced Labs and ECG. See src/projections/health_features.ts for the
// routes and what is and isn't verified. Read-only on purpose: the writes these
// features have (deleting AFib history, editing lab results or ECG notes) can't
// be tried without an account that has them, and some can't be undone.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { HealthOut } from "../../schemas/health.js";
import {
  HEALTH_FEATURES, passThrough, projectBiomarker, projectEcgAbout, projectLabs, projectLabTests, projectLockable, type HealthFeature,
} from "../../projections/health_features.js";
import { WhoopApiError, WhoopAuthExpiredError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";

const NAME = "whoop_health";
const LABS = "/advanced-labs-service/v1/advanced-labs";
const NO_ECG_ROUTE =
  "WHOOP's app API has no route totem knows of that lists ECG recordings, so they can't be read here; open ECG in the WHOOP app.";

const isStatus = (e: unknown, ...codes: number[]): boolean => e instanceof WhoopApiError && codes.includes(e.status);

/** One read: its projection, or why it couldn't be read. A 404 means the feature isn't set up. */
async function feature(read: Promise<unknown>, project: (raw: unknown) => HealthFeature, notSetUp: string): Promise<HealthFeature> {
  try {
    return project(await read);
  } catch (e) {
    if (e instanceof WhoopAuthExpiredError) throw e;
    if (isStatus(e, 404)) return { status: "not_set_up", message: notSetUp };
    return { status: "unavailable", message: (e as Error).message };
  }
}

/** labs with an id: a biomarker's history, else a test's results and insights (id formats are unseen, so both are tried). */
async function labDetail(client: WhoopClient, id: string, cursor: string | undefined, warnings: string[]): Promise<HealthFeature> {
  const enc = encodeURIComponent(id);
  try {
    return projectBiomarker(await client.get(`${LABS}/biomarkers/${enc}`, cursor ? { next_token: cursor } : {}));
  } catch (e) {
    if (e instanceof WhoopAuthExpiredError || !isStatus(e, 400, 404)) throw e;
  }
  try {
    const [test, insights] = await Promise.all([
      client.get(`${LABS}/tests/${enc}`),
      client.get(`${LABS}/insights`, { testId: id }).catch((e: unknown) => {
        if (e instanceof WhoopAuthExpiredError) throw e;
        warnings.push(`Insights unavailable: ${(e as Error).message}`);
        return null;
      }),
    ]);
    return passThrough({ test, insights }, 3_000);
  } catch (e) {
    if (e instanceof WhoopAuthExpiredError || !isStatus(e, 400, 404)) throw e;
    return { status: "no_data", message: `No biomarker or lab test ${id}. Ids come from labs without an id.` };
  }
}

export function registerHealth(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "EXPERIMENTAL, untested: fields may be missing or misnamed. healthspan or " +
      "blood_pressure for a date; afib history (date: a day; cursor: next page); labs: biomarkers and tests (id: one of them); " +
      "ecg: device info only (no route to recordings).",
    input: {
      feature: z.enum(HEALTH_FEATURES),
      date: z.iso.date().optional(),
      id: z.string().min(1).optional(),
      cursor: z.string().min(1).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ feature: name, date, id, cursor }) => {
    const warnings: string[] = [];
    const day = date ?? todayIso();
    let out: HealthFeature;
    let shown: { date?: string; id?: string } = {};
    switch (name) {
      case "healthspan":
        out = await feature(client.get("/healthspan-service/v1/healthspan/bff", { date: day }), projectLockable, "Healthspan isn't available on this account.");
        shown = { date: day };
        break;
      case "blood_pressure":
        out = await feature(client.get("/sage-service/v1/sage/bff", { date: day }), projectLockable, "Blood pressure insights aren't available on this account.");
        shown = { date: day };
        break;
      case "afib": {
        const read = cursor ? client.get("/arrhythmia-service/v2/afibhistory/paginated", { next_token: cursor })
          : date ? client.get("/arrhythmia-service/v1/history/bff", { historyDate: date })
          : client.get("/arrhythmia-service/v2/afibhistory/screen");
        out = await feature(read, (raw) => passThrough(raw), "Irregular rhythm notifications aren't set up on this account.");
        if (date && !cursor) shown = { date };
        break;
      }
      case "labs":
        if (id) {
          out = await labDetail(client, id, cursor, warnings);
          shown = { id };
        } else {
          const [summary, tests] = await Promise.all([
            feature(client.get(`${LABS}/biomarkers/summary`), projectLabs, "Advanced Labs isn't available on this account."),
            client.get(`${LABS}/tests/history`).then(projectLabTests).catch((e: unknown) => {
              if (e instanceof WhoopAuthExpiredError) throw e;
              warnings.push(`Lab history unavailable: ${(e as Error).message}`);
              return null;
            }),
          ]);
          out = tests ? { ...summary, ...(summary.status === "no_data" ? { status: "available" as const, message: null } : {}), tests } : summary;
        }
        break;
      case "ecg": {
        const about = await feature(client.get("/ecg-service/v1/ecg/about"), (raw) => ({ status: "not_readable", about: projectEcgAbout(raw) }), "ECG isn't available on this account.");
        out = about.status === "not_readable" ? { ...about, message: NO_ECG_ROUTE } : about;
        break;
      }
    }
    return respond(NAME, HealthOut, { feature: name, experimental: true, ...shown, ...out, warnings });
  });
}
