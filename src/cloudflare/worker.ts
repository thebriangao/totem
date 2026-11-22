// totem on Cloudflare Workers: the same HTTP server, sign-in page and tools as
// the Node build (src/server-http.ts), running inside one Durable Object.
//
// Why one Durable Object: WHOOP rotates the refresh token on every refresh, so
// exactly one place may own the login. Every request is routed to the single
// object named "totem"; its SQLite storage holds the login and the device id,
// and its alarm wakes it to keep the login fresh while nobody is calling.
//
// What differs from Node, and why:
//  - The server starts on the first request, not at load: Workers forbid timers,
//    random values and I/O while the module loads.
//  - It is started once per runtime, not once per object instance: Cloudflare
//    may rebuild the object while the loaded code (and the port it listens on)
//    stays, and a second listen() would fail with "address in use".
//  - No disk: the login lives in the object's storage (token_store.ts).
//  - Timers stop when the object sleeps, so an alarm runs the keep-alive.
//  - MCP sessions are held in memory, as on Node. When Cloudflare restarts the
//    object they are gone; a client then gets 404 for its session and starts a
//    new one, which the MCP spec requires clients to do.

import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { randomUUID } from "node:crypto";
import { startHttpServer } from "../server-http.js";
import { WhoopClient } from "../whoop/client.js";
import { TokenManager } from "../whoop/token_manager.js";
import { startTimezoneAutoDetect } from "../whoop/init_timezone.js";
import { DurableKv, DurableTokenStore, type SqlLike } from "./token_store.js";

interface Env {
  TOTEM: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  MCP_AUTH_TOKEN?: string;
  AUTH_PASSWORD?: string;
  /** Optional: the public address, when it isn't the one requests arrive on (a custom domain behind another proxy). */
  PUBLIC_URL?: string;
  WHOOP_TIMEZONE?: string;
}

/** The port the in-runtime HTTP server listens on; never reachable from outside. */
const PORT = 8080;
/** Longest the object sleeps between keep-alive checks. */
const MAX_ALARM_GAP_MS = 60 * 60_000;
const MIN_ALARM_GAP_MS = 60_000;

type Handler = ReturnType<typeof httpServerHandler>;
interface Running {
  app: Handler;
  tokens: TokenManager;
}

// Per runtime, shared by every instance of the object (see the header).
let running: Running | undefined;
let starting: Promise<Running> | undefined;
let currentSql: SqlLike | undefined;

const kv = (): DurableKv => new DurableKv(() => currentSql!);

function start(env: Env, origin: string): Promise<Running> {
  starting ??= (async () => {
    // The server reads its settings from process.env, as on Node.
    for (const key of ["MCP_AUTH_TOKEN", "AUTH_PASSWORD", "WHOOP_TIMEZONE"] as const) {
      const v = env[key];
      if (typeof v === "string" && v !== "") process.env[key] = v;
    }
    process.env.PUBLIC_URL = (env.PUBLIC_URL || origin).replace(/\/+$/, "");

    // One device id for this install, kept with the login (WHOOP sees the same
    // device on every request, across restarts).
    const store = kv();
    let installationId = store.get("installation_id");
    if (!installationId) {
      installationId = randomUUID().toUpperCase();
      store.set("installation_id", installationId);
    }
    process.env.WHOOP_INSTALLATION_ID = installationId;

    let whoop: WhoopClient | undefined;
    const tokens = new TokenManager({
      store: new DurableTokenStore(kv()),
      lock: null, // one object owns the login; there is no second process to lock out
      onFatal: () => { /* logged by the manager; the next request reports it */ },
      onLoginChange: (record) => {
        if (record?.user_id) process.env.WHOOP_USER_ID = String(record.user_id);
        if (whoop) {
          whoop.invalidateAll();
          if (record) startTimezoneAutoDetect(whoop);
        }
      },
    });
    tokens.start();
    const current = tokens.current();
    if (current?.user_id) process.env.WHOOP_USER_ID = String(current.user_id);
    if (current && !current.installation_id) tokens.annotate({ installation_id: installationId });

    whoop = new WhoopClient({ getToken: () => tokens.getToken(), onUnauthorized: (t) => tokens.invalidate(t) });
    if (current) startTimezoneAutoDetect(whoop);

    await startHttpServer(whoop, {
      authToken: env.MCP_AUTH_TOKEN ?? "",
      port: PORT,
      host: "0.0.0.0", // inside the runtime only; the object's fetch() is the way in
      tokens,
      installationId: () => installationId!,
    });
    running = { app: httpServerHandler({ port: PORT }), tokens };
    return running;
  })();
  // A failed start (a missing secret) is retried on the next request, after the fix.
  starting.catch(() => { starting = undefined; });
  return starting;
}

/** A plain page for the one failure a person can fix from the dashboard. */
function setupProblem(message: string): Response {
  return new Response(`totem is deployed but not set up: ${message}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export class Totem extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    currentSql = ctx.storage.sql;
  }

  private async scheduleWake(tokens: TokenManager): Promise<void> {
    const now = Date.now();
    const due = tokens.nextRefreshAt() ?? now + MAX_ALARM_GAP_MS;
    const at = Math.min(Math.max(due, now + MIN_ALARM_GAP_MS), now + MAX_ALARM_GAP_MS);
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  override async fetch(request: Request): Promise<Response> {
    currentSql = this.ctx.storage.sql;
    if ((this.env.MCP_AUTH_TOKEN ?? "").length < 32) {
      return setupProblem("set the MCP_AUTH_TOKEN secret (64 random characters: openssl rand -hex 32), then deploy again.");
    }
    const origin = new URL(request.url).origin;
    // Remembered for the alarm, which may be the first thing to start the server after a restart.
    const store = kv();
    if (store.get("origin") !== origin) store.set("origin", origin);
    const { app, tokens } = await start(this.env, origin);

    // The caller's address for the sign-in rate limits: Express trusts one
    // proxy hop, so the last X-Forwarded-For entry must be the real client,
    // never a value the client sent.
    const headers = new Headers(request.headers);
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers.set("x-forwarded-for", ip);
    else headers.delete("x-forwarded-for");
    const response = await app.fetch(new Request(request, { headers }), this.env, this.ctx);

    await this.scheduleWake(tokens);
    return response;
  }

  override async alarm(): Promise<void> {
    currentSql = this.ctx.storage.sql;
    if ((this.env.MCP_AUTH_TOKEN ?? "").length < 32) return;
    // The address requests last arrived on, so sign-in links stay right when
    // the alarm is what starts the server.
    const { tokens } = await start(this.env, kv().get("origin") ?? "http://localhost");
    await tokens.wake();
    await this.scheduleWake(tokens);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.TOTEM.getByName("totem").fetch(request);
  },
};
