import { describe, it, expect } from "vitest";
import { sleepActivity } from "../../src/tools/v2/sleep_edit.js";

describe("sleepActivity", () => {
  it("extracts activity_id + window from the deep-dive header", () => {
    const raw = {
      header_section: {
        destination: {
          parameters: {
            activity_id: "abc-123",
            start_time: "2026-06-12T23:40:00.000Z",
            end_time: "2026-06-13T07:15:00.000Z",
          },
        },
      },
    };
    expect(sleepActivity(raw)).toEqual({
      activityId: "abc-123",
      start: "2026-06-12T23:40:00.000Z",
      end: "2026-06-13T07:15:00.000Z",
    });
  });

  it("returns nulls when the shape is absent", () => {
    expect(sleepActivity({})).toEqual({ activityId: null, start: null, end: null });
    expect(sleepActivity(null)).toEqual({ activityId: null, start: null, end: null });
  });
});
