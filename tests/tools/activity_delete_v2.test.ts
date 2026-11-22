// whoop_activity_delete (v2): route by the pre-read's kind, verify gone with a
// fresh read (WHOOP answers 204 even for ids that don't exist).
import { describe, expect, it } from "vitest";
import { registerActivityDeleteV2 } from "../../src/tools/v2/activity_delete_v2.js";
import { activityRecord, badRequest, cardioDetails, connect, fakeWhoop, notFound, sleepDetails, textOf, unrouted, type Call } from "./activity_test_utils.js";

const CARDIO_V1 = "/core-details-bff/v1/cardio-details";

async function deleteTool(route: (c: Call) => unknown) {
  const fake = fakeWhoop(route);
  const client = await connect((s) => registerActivityDeleteV2(s, fake.whoop));
  return { ...fake, call: (args: Record<string, unknown>) => client.callTool({ name: "whoop_activity_delete", arguments: args }) };
}

describe("whoop_activity_delete", () => {
  it("previews, then deletes a CARDIO activity via cardio-details and confirms the 404", async () => {
    let deleted = false;
    const t = await deleteTool((c) => {
      if (c.method === "GET" && c.path === "/activities-service/v2/activities/a1") {
        if (deleted) throw notFound(c.path);
        return activityRecord({ id: "a1", type: "boxing" }, false);
      }
      if (c.method === "DELETE" && c.path === CARDIO_V1) { deleted = true; return undefined; }
      if (c.method === "GET" && c.path === CARDIO_V1) {
        if (deleted) throw notFound(c.path);
        return cardioDetails("boxing", "2026-11-21T16:40:00.000Z", "2026-11-21T16:45:00.000Z");
      }
      return unrouted(c);
    });
    const preview = textOf(await t.call({ activity_id: "a1" }));
    expect(preview).toMatchObject({ preview: true, will_execute: { method: "DELETE", path: `${CARDIO_V1}?activityId=a1` } });
    expect(t.writes()).toHaveLength(0);

    const r = textOf(await t.call({ activity_id: "a1", confirm: true }));
    expect(t.writes()).toEqual([{ method: "DELETE", path: CARDIO_V1, query: { activityId: "a1" } }]);
    const verify = t.calls.filter((c) => c.method === "GET" && c.path === CARDIO_V1).pop()!;
    expect(verify).toMatchObject({ query: { activityId: "a1" }, fresh: true });
    expect(r).toMatchObject({ deleted: true, verified: true, type: "boxing", score_type: "CARDIO" });
  });

  it("routes a nap to DELETE sleep-details/{id} (type from the pre-read)", async () => {
    let deleted = false;
    const t = await deleteTool((c) => {
      if (c.path === "/activities-service/v2/activities/n1") throw notFound(c.path); // force the screen fallbacks
      if (c.method === "GET" && c.path === CARDIO_V1) throw badRequest(c.path, "Cannot view activity details for a pending activity");
      if (c.method === "GET" && c.path === "/core-details-bff/v2/sleep-details/n1") {
        if (deleted) throw notFound(c.path);
        return sleepDetails(true, "2026-11-21T08:30:00.000Z", "2026-11-21T09:00:00.000Z");
      }
      if (c.method === "DELETE" && c.path === "/core-details-bff/v2/sleep-details/n1") { deleted = true; return undefined; }
      return unrouted(c);
    });
    const r = textOf(await t.call({ activity_id: "n1", confirm: true }));
    expect(t.writes()).toEqual([{ method: "DELETE", path: "/core-details-bff/v2/sleep-details/n1", query: {} }]);
    expect(r).toMatchObject({ deleted: true, type: "nap", score_type: "SLEEP", verified: true });
  });

  it("warns that deleting a main sleep doesn't restore cycles", async () => {
    const t = await deleteTool((c) => {
      if (c.path === "/activities-service/v2/activities/s1") return activityRecord({ id: "s1", type: "sleep", score_type: "SLEEP" }, false);
      return unrouted(c);
    });
    expect(JSON.stringify(textOf(await t.call({ activity_id: "s1" })))).toContain("does not restore the cycles");
  });

  it("reports deleted:false when WHOOP answers 204 but the activity is still there", async () => {
    const t = await deleteTool((c) => {
      if (c.path === "/activities-service/v2/activities/a2") return activityRecord({ id: "a2", type: "golf" }, false);
      if (c.method === "DELETE") return undefined;
      if (c.method === "GET" && c.path === CARDIO_V1) return cardioDetails("golf", "2026-11-21T16:40:00.000Z", "2026-11-21T16:45:00.000Z");
      return unrouted(c);
    });
    const r = textOf(await t.call({ activity_id: "a2", confirm: true }));
    expect(r).toMatchObject({ deleted: false, verified: false });
    expect(String(r.warnings)).toContain("still returns");
  });

  it("treats a 404 on DELETE as already gone, then confirms", async () => {
    let attempted = false;
    const t = await deleteTool((c) => {
      if (c.path === "/activities-service/v2/activities/a3") {
        if (attempted) throw notFound(c.path);
        return activityRecord({ id: "a3", type: "golf" }, false);
      }
      if (c.method === "DELETE") { attempted = true; throw notFound(c.path, "Client exception, status code: 404, from client: ApiActivityClient, with response body: Trying to delete activity that doesn't exist"); }
      if (c.method === "GET" && c.path === CARDIO_V1) throw notFound(c.path);
      return unrouted(c);
    });
    const r = textOf(await t.call({ activity_id: "a3", confirm: true }));
    expect(r).toMatchObject({ deleted: true, verified: true });
  });

  it("refuses an id WHOOP doesn't know, without sending a DELETE", async () => {
    const t = await deleteTool((c) => { throw notFound(c.path); });
    const r = await t.call({ activity_id: "nope", confirm: true });
    expect(r.isError).toBe(true);
    expect(t.writes()).toHaveLength(0);
  });
});
