import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ExerciseInfoSchema,
  BootstrapSchema,
  JournalDraftSchema,
} from "../../src/whoop/types.js";

const FIXTURE = (name: string) => resolve("tests/fixtures", name);
const load = (name: string): unknown => {
  const path = FIXTURE(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
};

describe("zod schemas against captured fixtures", () => {
  it("ExerciseInfoSchema parses a real /v1/exercise/ response", () => {
    const data = load("exercise_info.json");
    expect(data).not.toBeNull();
    expect(() => ExerciseInfoSchema.parse(data)).not.toThrow();
  });

  it("BootstrapSchema parses a real /v2/bootstrap response", () => {
    const data = load("bootstrap.json");
    expect(data).not.toBeNull();
    expect(() => BootstrapSchema.parse(data)).not.toThrow();
  });

  it("JournalDraftSchema parses a real journal draft response", () => {
    const data = load("journal_draft.json");
    expect(data).not.toBeNull();
    expect(() => JournalDraftSchema.parse(data)).not.toThrow();
  });
});
