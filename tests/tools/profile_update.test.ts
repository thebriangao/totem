import { describe, expect, it } from "vitest";
import { registerProfileUpdate } from "../../src/tools/v2/profile_update.js";
import { connect, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

const EDIT_PATH = "/profile-service/v1/profile/bff/edit";
const PUT_PATH = "/profile-service/v1/profile";
const EDIT = {
  first_name: "Test", last_name: "User", email: "tester@example.com", city: "Springfield", country: "US", state: "IL",
  height: 1.8, weight: 80.5, birthday: "1990-05-05", unit_system: "metric", gender: "FEMALE", physiological_baseline: "MALE",
  locked_fields: [],
};
const seq = (...values: unknown[]) => (n: number) => values[Math.min(n, values.length) - 1];

async function call(whoop: ReturnType<typeof mockWhoop>, args: Record<string, unknown>) {
  const client = await connect(registerProfileUpdate, whoop);
  const result = await client.callTool({ name: "whoop_profile_update", arguments: { confirm: true, ...args } });
  return { result, out: parse(result) };
}

describe("whoop_profile_update", () => {
  it("merges from a fresh edit-screen read, converts lb, keeps city and leaves the baseline out", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: seq(EDIT, { ...EDIT, weight: 99.79 }) });
    whoop.put.mockResolvedValueOnce(true);
    const { out } = await call(whoop, { weight: 220, weight_unit: "lb" });
    expect(whoop.get).toHaveBeenCalledWith(EDIT_PATH, {}, { fresh: true });
    expect(whoop.put).toHaveBeenCalledWith(PUT_PATH, {
      first_name: "Test", last_name: "User", email: "tester@example.com", birthday: "1990-05-05", gender: "FEMALE",
      weight: 99.79, height: 1.8, country: "US", unit_system: "metric", city: "Springfield", state: "IL",
    });
    expect(out).toMatchObject({ updated: true, verified: true, changed: { weight: [80.5, 99.79] } });
    expect(out.warnings.join(" ")).toMatch(/weight reading/);
  });

  it("sends the gender enum as given (PREFER_NOT) and the baseline only when asked", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: seq(EDIT, { ...EDIT, gender: "PREFER_NOT", physiological_baseline: "FEMALE" }) });
    whoop.put.mockResolvedValueOnce(true);
    const { out } = await call(whoop, { gender: "PREFER_NOT", physiological_baseline: "FEMALE" });
    expect(whoop.put.mock.calls[0]![1]).toMatchObject({ gender: "PREFER_NOT", physiological_baseline: "FEMALE" });
    expect(out.verified).toBe(true);
  });

  it("treats WHOOP's `false` answer as a failure", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: EDIT });
    whoop.put.mockResolvedValueOnce(false);
    const { result, out } = await call(whoop, { first_name: "New" });
    expect(result.isError).toBe(true);
    expect(out.error).toMatch(/answered false/);
  });

  it("warns that a birthday change ends the session (the client's 401 refresh handles it)", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: seq(EDIT, { ...EDIT, birthday: "1991-01-01" }) });
    whoop.put.mockResolvedValueOnce(true);
    const { out } = await call(whoop, { birthday: "1991-01-01" });
    expect(out.verified).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/ends the current session.*refreshes the token/);
  });

  it("drops the old state on a country change and requires one for the US", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: seq(EDIT, { ...EDIT, country: "CA", state: null }) });
    whoop.put.mockResolvedValueOnce(true);
    await call(whoop, { country: "ca" });
    expect(whoop.put.mock.calls[0]![1]).toMatchObject({ country: "CA" });
    expect(whoop.put.mock.calls[0]![1]).not.toHaveProperty("state");

    const usNoState = mockWhoop({ [EDIT_PATH]: { ...EDIT, country: "CA", state: null } });
    const { result } = await call(usNoState, { country: "US" });
    expect(result.isError).toBe(true);
    expect(usNoState.put).not.toHaveBeenCalled();
  });

  it("does nothing when the values already match", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: EDIT });
    const { out } = await call(whoop, { height: 180, height_unit: "cm" });
    expect(whoop.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ updated: false, no_change: true });
  });

  it("previews only the changes", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: EDIT });
    const { out } = await call(whoop, { city: "Chicago", confirm: false });
    expect(whoop.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ preview: true, will_execute: { method: "PUT", path: PUT_PATH, body_summary: { changes: { city: ["Springfield", "Chicago"] } } } });
  });

  it("never falls back to bootstrap when the edit screen can't be read", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: new Error("down"), "/users-service/v2/bootstrap": {} });
    const { result } = await call(whoop, { first_name: "New" });
    expect(result.isError).toBe(true);
    expect(whoop.get).not.toHaveBeenCalledWith("/users-service/v2/bootstrap", expect.anything(), expect.anything());
    expect(whoop.put).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["weight above 272 kg", { weight: 700, weight_unit: "lb" }, /24–272 kg/],
    ["height above 2.72 m", { height: 3 }, /0.91–2.72 m/],
    ["future birthday", { birthday: "2099-01-01" }, /future/],
    ["weight_unit without weight", { weight_unit: "lb" }, /needs weight/],
    ["no fields", {}, /at least one/],
  ];
  for (const [label, args, message] of refusals) {
    it(`refuses ${label} before reading anything`, async () => {
      const whoop = mockWhoop({ [EDIT_PATH]: EDIT });
      const { result } = await call(whoop, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(message);
      expect(whoop.get).not.toHaveBeenCalled();
    });
  }

  it("refuses an unknown gender (schema enum)", async () => {
    const whoop = mockWhoop({ [EDIT_PATH]: EDIT });
    const { result } = await call(whoop, { gender: "UNSPECIFIED" });
    expect(result.isError).toBe(true);
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerProfileUpdate, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(600);
      expect(t.longestDescribe).toBeLessThanOrEqual(80);
    }
  });
});
