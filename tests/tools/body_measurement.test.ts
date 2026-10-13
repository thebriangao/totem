import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { registerBodyMeasurementLog } from "../../src/tools/v2/body_measurement_log.js";
import { buildMeasurementBody } from "../../src/whoop/build_measurement_body.js";
import { registerBodyMeasurementDelete } from "../../src/tools/v2/body_measurement_delete.js";
import { registerBodyMeasurements } from "../../src/tools/v2/body_measurements.js";
import { BODY_READINGS_PATH as PATH } from "../../src/projections/body_measurements.js";

const closers: Array<() => Promise<void>> = [];
const previousTimezone = process.env.WHOOP_TIMEZONE;

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  if (previousTimezone === undefined) delete process.env.WHOOP_TIMEZONE;
  else process.env.WHOOP_TIMEZONE = previousTimezone;
});

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

function json(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("buildMeasurementBody", () => {
  const ts = "2026-10-13T09:30:00+03:00";

  it("sends weight alone with null body composition", () => {
    expect(buildMeasurementBody({ timestamp: ts, weight_kg: 80.5 })).toEqual({
      timestamp: "2026-10-13T09:30:00.000+0300",
      weight_kg: 80.5,
      body_fat_percent: null,
      lean_body_mass_kg: null,
    });
  });

  it("derives body fat (as a fraction) from lean body mass", () => {
    const body = buildMeasurementBody({ timestamp: ts, weight_kg: 80, lean_body_mass_kg: 64 });
    expect(body.lean_body_mass_kg).toBe(64);
    expect(body.body_fat_percent).toBeCloseTo(0.2, 10);
  });

  it("converts a body-fat percentage to the wire fraction and derives lean mass", () => {
    const body = buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 18.5 });
    expect(body.body_fat_percent).toBeCloseTo(0.185, 10);
    expect(body.lean_body_mass_kg).toBeCloseTo(65.2, 10);
  });

  it("rejects lean mass that is not below body weight", () => {
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 70, lean_body_mass_kg: 70 })).toThrow(/lean/i);
  });

  it("rejects body fat and lean mass that disagree", () => {
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 18.5, lean_body_mass_kg: 70 })).toThrow(/disagree/i);
  });
});

describe("whoop_body_measurement_log", () => {
  it("previews without posting, then posts the app's body on confirm", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementLog(server, whoop));
    const args = { timestamp: "2026-10-13T09:30:00+03:00", weight_kg: 80, lean_body_mass_kg: 64 };

    const preview = json(await client.callTool({ name: "whoop_body_measurement_log", arguments: args }));
    expect(preview.preview).toBe(true);
    expect(post).not.toHaveBeenCalled();

    const result = await client.callTool({ name: "whoop_body_measurement_log", arguments: { ...args, confirm: true } });
    expect(result.isError).toBeFalsy();
    expect(post).toHaveBeenCalledWith(PATH, {
      timestamp: "2026-10-13T09:30:00.000+0300",
      weight_kg: 80,
      body_fat_percent: expect.closeTo(0.2, 10),
      lean_body_mass_kg: 64,
    });
    expect(json(result)).toMatchObject({ logged: true, weight_kg: 80, lean_body_mass_kg: 64, body_fat_percent: 20 });
  });

  it("sends a UTC timestamp in the member's local offset, as the app does", async () => {
    process.env.WHOOP_TIMEZONE = "Europe/Moscow";
    const post = vi.fn().mockResolvedValue(undefined);
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementLog(server, whoop));

    const preview = json(await client.callTool({
      name: "whoop_body_measurement_log",
      arguments: { timestamp: "2026-10-13T06:30:00Z", weight_kg: 80 },
    }));
    expect((preview.will_execute as { body_summary: { timestamp: string } }).body_summary.timestamp)
      .toBe("2026-10-13T09:30:00.000+0300");
  });

  it("returns a tool error instead of posting an impossible composition", async () => {
    const post = vi.fn();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementLog(server, whoop));
    const result = await client.callTool({
      name: "whoop_body_measurement_log",
      arguments: { timestamp: "2026-10-13T09:30:00+03:00", weight_kg: 60, lean_body_mass_kg: 75, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("whoop_body_measurements", () => {
  it("lists readings from the WEIGHT readings endpoint", async () => {
    const raw = JSON.parse(readFileSync(resolve("tests/fixtures", "body_readings.json"), "utf8")) as unknown;
    const get = vi.fn().mockResolvedValue(raw);
    const whoop = { get } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurements(server, whoop));
    const result = json(await client.callTool({ name: "whoop_body_measurements", arguments: {} }));
    expect(get).toHaveBeenCalledWith(PATH);
    expect((result.readings as unknown[]).length).toBe(2);
  });
});

describe("whoop_body_measurement_delete", () => {
  it("deletes a reading by id only on confirm", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const whoop = { delete: del } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementDelete(server, whoop));

    await client.callTool({ name: "whoop_body_measurement_delete", arguments: { reading_id: "reading-1" } });
    expect(del).not.toHaveBeenCalled();

    const result = json(await client.callTool({ name: "whoop_body_measurement_delete", arguments: { reading_id: "reading-1", confirm: true } }));
    expect(del).toHaveBeenCalledWith(`${PATH}/reading-1`);
    expect(result).toEqual({ deleted: true, reading_id: "reading-1" });
  });

  it("turns a WHOOP rejection into a structured tool error", async () => {
    const del = vi.fn().mockRejectedValue(new WhoopApiError(404, `${PATH}/missing`, '{"message":"not found"}'));
    const whoop = { delete: del } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementDelete(server, whoop));

    const result = await client.callTool({ name: "whoop_body_measurement_delete", arguments: { reading_id: "missing", confirm: true } });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ status: 404, reason: "not found" });
  });
});
