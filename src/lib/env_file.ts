// Shared .env reader/writer.
//
// Why this exists: values were previously written unquoted, but dotenv treats an
// unquoted `#` as the start of an inline comment and trims surrounding
// whitespace. A Whoop password of `#hunter2` therefore parsed back as `""`, and
// `abc#def` as `abc` — an auth failure that looks like a wrong password
// (issue #27). Every reader and writer now goes through this module so the value
// that comes out is byte-for-byte the value that went in.
//
// Quoting rules, verified against dotenv's actual parser:
//   bare      value ends at a `#` and is trimmed  → only safe for "plain" values
//   '...'     literal, but a `'` inside cannot be escaped
//   "..."     expands \n and \r, and does not unescape \" → no `"` or backslash
//   `...`     literal, but a backtick inside cannot be escaped
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { parse } from "dotenv";

/** Characters that make an unquoted value parse back as something else. */
const BARE_UNSAFE = /[#'"`\\\r\n]/;
/** A `KEY=` assignment line (leading whitespace and `export ` tolerated). */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Quote `value` so `dotenv.parse` returns it unchanged. Prefers the least
 * noisy form that round-trips.
 */
export function serializeEnvValue(value: string): string {
  if (value !== "" && !BARE_UNSAFE.test(value) && value.trim() === value) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error(
    "Cannot represent a value containing all of ' \" and ` in a .env file. Change the value or set it directly in the environment.",
  );
}

export function serializeEnvLine(key: string, value: string): string {
  return `${key}=${serializeEnvValue(value)}`;
}

/** Parse with dotenv itself, so reads match what the server sees at boot. */
export function parseEnvText(text: string): Record<string, string> {
  return parse(text);
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Update keys in place, preserving comments, blank lines and unrelated
 * entries. Duplicate assignments of an updated key collapse to one; keys not
 * already present are appended. Written 0600 — this file holds tokens.
 */
export function upsertEnvFile(path: string, updates: Record<string, string>): void {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.length > 0 ? raw.split("\n") : [];
  // A trailing newline yields a final empty element; drop it and re-add on write
  // so appended keys don't land after a blank line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const pending = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key !== undefined && Object.prototype.hasOwnProperty.call(updates, key)) {
      // First occurrence becomes the new value; later duplicates are dropped.
      if (pending.has(key)) {
        out.push(serializeEnvLine(key, pending.get(key)!));
        pending.delete(key);
      }
      continue;
    }
    out.push(line);
  }
  for (const [key, value] of pending) out.push(serializeEnvLine(key, value));

  writeFileSync(path, out.join("\n") + "\n", { mode: 0o600 });
  // mode only applies on create, so repair files written by older versions.
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
}

/** Remove keys entirely (used to wipe the one-time password after bootstrap). */
export function deleteEnvKeys(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((line) => {
    const key = ASSIGNMENT.exec(line)?.[1];
    return key === undefined || !keys.includes(key);
  });
  writeFileSync(path, kept.join("\n") + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}
