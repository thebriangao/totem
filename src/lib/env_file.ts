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
//   bare      value ends at a `#` and is trimmed  → only safe for "plain" values;
//             backslashes are left alone, so a plain value may contain them
//   '...'     literal, but a `'` inside cannot be escaped
//   "..."     expands \n and \r, and does not unescape \" → no `"` or backslash
//   `...`     literal, but a backtick inside cannot be escaped
//   any quote a backslash right before the closing quote reads as an escaped
//             quote, so the value runs on to the next quote in the FILE and
//             swallows the lines between (see assertReadsBack)
//   CR        dotenv turns every CR / CRLF in the file into LF before parsing,
//             so only "..." (as the escape \r) can hold one
import {
  readFileSync, writeFileSync, existsSync, chmodSync,
  openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, realpathSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";

/** Characters that make an unquoted value parse back as something else. */
const BARE_UNSAFE = /[#'"`\r\n]/;
/** A `KEY=` assignment line (leading whitespace and `export ` tolerated). */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Quote `value` so `dotenv.parse` returns it unchanged. Prefers the least
 * noisy form that round-trips.
 */
export function serializeEnvValue(value: string): string {
  if (value !== "" && !BARE_UNSAFE.test(value) && value.trim() === value) return value;
  const literal = !value.includes("\r");
  if (literal && !value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value.replace(/\r/g, "\\r")}"`;
  if (literal && !value.includes("`")) return `\`${value}\``;
  throw new Error(
    "Cannot represent this value in a .env file (it mixes ' \" and `, or a carriage return with a backslash or double quote). Change the value or set it directly in the environment.",
  );
}

/**
 * Refuse a rewrite that dotenv would not read back as intended: every key in
 * `updates` must parse to its new value, every key in `removed` must be gone,
 * and every other key must parse to what it did before.
 *
 * Quoting one value correctly is not enough. A quoted value ending in a
 * backslash (`K='#pw\'`) parses fine alone, but dotenv takes `\'` for an
 * escaped quote when a later line offers another quote to close on: the value
 * then swallows the following lines, and the keys on them vanish. Only the
 * whole file shows that, so check the whole file before it replaces the old one.
 */
function assertReadsBack(
  before: string,
  after: string,
  updates: Record<string, string>,
  removed: readonly string[] = [],
): void {
  const was = parse(before);
  const now = parse(after);
  const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  const broken = new Set<string>();
  for (const [key, value] of Object.entries(updates)) if (now[key] !== value) broken.add(key);
  for (const key of removed) if (own(now, key)) broken.add(key);
  for (const [key, value] of Object.entries(was)) {
    if (!own(updates, key) && !removed.includes(key) && now[key] !== value) broken.add(key);
  }
  // Keys that newly APPEAR are fine: rewriting a value that used to swallow its
  // neighbours (files written before this check) is how those lines come back.
  if (broken.size > 0) {
    throw new Error(
      `Refusing to rewrite the .env file: ${[...broken].join(", ")} would not read back intact ` +
        "(a value ending in a backslash, or spanning lines, next to another quoted value). " +
        "The file was left unchanged. Change the value, or set it directly in the environment.",
    );
  }
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

/** Errors that mean "can't swap a new file in here", not "the disk is failing". */
const NO_SWAP = new Set(["EACCES", "EPERM", "EROFS", "EBUSY", "EXDEV", "ENOTSUP"]);

/**
 * Replace the file's contents in one step, 0600. The text goes to a sibling
 * temp file that is then renamed over the target, so the file is always either
 * the old version or the new one.
 *
 * Writing in place truncates first. Several totem processes share this file
 * (one per MCP client, plus `totem auth`) and refresh tokens at the same moment,
 * since they hold the same access token. A process reading during another's
 * rewrite saw an empty file about one read in six when measured, which at boot
 * is "Missing WHOOP_EMAIL"; and a crash or a full disk mid-write left every
 * credential gone.
 *
 * Where a sibling can't be created or renamed in (a read-only directory, a
 * single file bind-mounted into a container) it falls back to the in-place
 * write. Any other failure is rethrown with the original file untouched.
 */
function replaceFile(path: string, text: string): void {
  // Follow a symlinked .env so the link stays a link and its target is replaced.
  let target = path;
  try { target = realpathSync(path); } catch { /* doesn't exist yet */ }
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* nothing to clean up */ }
    if (!NO_SWAP.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    writeFileSync(target, text, { mode: 0o600 });
  }
  // The in-place path keeps an existing file's mode, so repair files written by older versions.
  try { chmodSync(target, 0o600); } catch { /* best-effort on exotic filesystems */ }
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

  const text = out.join("\n") + "\n";
  assertReadsBack(raw, text, updates);
  replaceFile(path, text);
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
  const text = kept.join("\n") + "\n";
  assertReadsBack(raw, text, {}, keys);
  replaceFile(path, text);
}
