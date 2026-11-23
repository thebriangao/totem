// The WHOOP login (and this install's device id) in a Durable Object's SQLite
// storage, for totem on Cloudflare Workers. Same contract as FileTokenStore:
// synchronous reads and writes, a version that changes on every save.
//
// Cloudflare can drop the object from memory when it is idle and build a new
// instance later while the loaded code keeps running. Each instance gets its
// own storage handle, so the store asks for the current one on every call
// instead of keeping the first.

import { parseTokenFile, serializeTokenFile, type TokenFileContent, type TokenStore } from "../whoop/token_store.js";

/** The slice of Cloudflare's SqlStorage this store uses. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

const LOGIN = "login";
const LOGIN_VERSION = "login_version";

/** A small key-value table in the object's SQLite database. */
export class DurableKv {
  constructor(private readonly sql: () => SqlLike) {
    this.sql().exec("CREATE TABLE IF NOT EXISTS totem_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  get(key: string): string | null {
    const rows = this.sql().exec("SELECT v FROM totem_kv WHERE k = ?", key).toArray();
    return rows.length > 0 ? String(rows[0]!.v) : null;
  }

  set(key: string, value: string): void {
    this.sql().exec("INSERT INTO totem_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
}

export class DurableTokenStore implements TokenStore {
  readonly path = null;
  readonly description = "Cloudflare Durable Object storage";

  constructor(private readonly kv: DurableKv) {}

  load(): TokenFileContent | null {
    const text = this.kv.get(LOGIN);
    return text === null ? null : parseTokenFile(text);
  }

  save(content: TokenFileContent): void {
    // One statement per key; SQLite in a Durable Object commits each write
    // before the next request is let in, so a reader never sees half a save.
    this.kv.set(LOGIN, serializeTokenFile(content));
    this.kv.set(LOGIN_VERSION, String(Number(this.kv.get(LOGIN_VERSION) ?? "0") + 1));
  }

  version(): string | null {
    return this.kv.get(LOGIN) === null ? null : this.kv.get(LOGIN_VERSION);
  }
}
