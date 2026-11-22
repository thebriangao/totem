// The few Cloudflare Workers runtime APIs src/cloudflare/worker.ts uses. Only
// the Workers runtime provides these modules; the Node build never loads them.

declare module "cloudflare:workers" {
  export interface DurableObjectStorage {
    sql: import("./token_store.js").SqlLike;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }
}

declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
}
