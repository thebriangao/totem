import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerJournalLog, specsFromDraft, verifyWritten } from "../../src/tools/v2/journal_log.js";

// Draft shape as the v3 endpoint returns it: the behavior's real question type
// and magnitude range live here, not in the bundled catalog.
function draft(inputs: Array<Record<string, unknown>>) {
  return {
    journal: {
      journal_entry_id: 1,
      notes: null,
      tracked_behaviors: [
        {
          behavior_tracker: {
            id: 1, title: "Alcohol", question_type: "YES_NO", internal_name: "alcohol",
            magnitude: { type: "range", units: "Drinks", minimum_inclusive: 1, maximum_inclusive: 20 },
          },
          tracker_input: inputs.find((i) => i.behavior_tracker_id === 1)
            ?? { behavior_tracker_id: 1, answered_yes: null, magnitude_input_value: null, time_input_value: null },
        },
        {
          behavior_tracker: {
            id: 52, title: "Sauna", question_type: "YES_NO", internal_name: "sauna",
            magnitude: { type: "range", units: "Minutes", minimum_inclusive: 1, maximum_inclusive: 300 },
          },
          tracker_input: inputs.find((i) => i.behavior_tracker_id === 52)
            ?? { behavior_tracker_id: 52, answered_yes: null, magnitude_input_value: null, time_input_value: null },
        },
      ],
    },
  };
}

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parse(result: unknown) {
  return JSON.parse(((result as { content: Array<{ text: string }> }).content)[0]!.text);
}

describe("whoop_journal_log", () => {
  it("answers the question so the row is visible in the app", async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = vi.fn()
      .mockResolvedValueOnce(draft([]))
      .mockResolvedValueOnce(draft([{ behavior_tracker_id: 52, answered_yes: true, magnitude_input_value: 9, time_input_value: 1788711660 }]));
    const whoop = { put, get } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));

    const result = await client.callTool({
      name: "whoop_journal_log",
      arguments: { date: "2026-09-06", behaviors: [{ behavior: "sauna", magnitude_value: 9, time: 1788711660 }], confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ logged: true, verified: true });
    expect(put.mock.calls[0]![1]).toMatchObject({
      tracker_inputs: [{ behavior_tracker_id: 52, answered_yes: true, magnitude_input_value: 9, magnitude_input_label: "9", time_input_value: 1788711660 }],
    });
  });

  it("accepts a magnitude the behavior really takes", async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = vi.fn()
      .mockResolvedValueOnce(draft([]))
      .mockResolvedValueOnce(draft([{ behavior_tracker_id: 1, answered_yes: true, magnitude_input_value: 2 }]));
    const whoop = { put, get } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));

    const result = await client.callTool({
      name: "whoop_journal_log",
      arguments: { date: "2026-09-05", behaviors: [{ behavior: "alcohol", magnitude_value: 2 }], confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects a magnitude outside the behavior's own range", async () => {
    const put = vi.fn();
    const get = vi.fn().mockResolvedValue(draft([]));
    const whoop = { put, get } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));

    const result = await client.callTool({
      name: "whoop_journal_log",
      arguments: { behaviors: [{ behavior: "sauna", magnitude_value: 900 }], confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("1-300 Minutes");
    expect(put).not.toHaveBeenCalled();
  });

  it("carries over answers it was not asked to change", async () => {
    const put = vi.fn().mockResolvedValue({});
    const existing = { behavior_tracker_id: 1, answered_yes: true, magnitude_input_value: 2, magnitude_input_label: "2" };
    const get = vi.fn()
      .mockResolvedValueOnce(draft([existing]))
      .mockResolvedValueOnce(draft([existing, { behavior_tracker_id: 52, answered_yes: true }]));
    const whoop = { put, get } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));

    const result = await client.callTool({
      name: "whoop_journal_log",
      arguments: { behaviors: [{ behavior: "sauna" }], confirm: true },
    });

    expect(parse(result)).toMatchObject({ preserved_count: 1 });
    expect(put.mock.calls[0]![1]).toMatchObject({
      tracker_inputs: [
        { behavior_tracker_id: 1, answered_yes: true, magnitude_input_value: 2 },
        { behavior_tracker_id: 52, answered_yes: true },
      ],
    });
  });

  it("fails when Whoop accepts the write but the day comes back unanswered", async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = vi.fn()
      .mockResolvedValueOnce(draft([]))
      .mockResolvedValueOnce(draft([]));
    const whoop = { put, get } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));

    const result = await client.callTool({
      name: "whoop_journal_log",
      arguments: { behaviors: [{ behavior: "sauna" }], confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(parse(result).unconfirmed_behavior_tracker_ids).toEqual([52]);
  });
});

describe("draft helpers", () => {
  it("reads the live question type and magnitude range", () => {
    const specs = specsFromDraft(draft([]));
    expect(specs.get(52)).toMatchObject({ question_type: "YES_NO", magnitude: { units: "Minutes", minimum: 1, maximum: 300 } });
  });

  it("treats an unanswered echo as unwritten", () => {
    const { verified, missing } = verifyWritten(draft([]), [{ behavior_tracker_id: 52, answered_yes: true }]);
    expect(verified).toBe(false);
    expect(missing).toEqual([52]);
  });
});
